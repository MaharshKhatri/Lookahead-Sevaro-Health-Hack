# Deploy Lookahead to EC2 (AWS Workshop Studio, us-east-1)

Copy-paste steps for **AWS CloudShell** (console → CloudShell icon, region **us-east-1**). Every AWS feature is optional: if a step is refused by the account's permissions, the **Fallback** under it keeps the demo working (file store + template narration). The app is identical either way.

No AWS keys go anywhere: CloudShell uses your console session, and the instance uses an **instance profile**. `OFFER_LINK_SECRET` is generated on the instance.

Total time: about 15 minutes, 6–8 of them waiting for the instance to build.

---

## 0. Variables

```sh
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export TABLE_NAME=lookahead-log
export BUCKET=lookahead-$ACCOUNT_ID
echo "$ACCOUNT_ID $BUCKET"
```

Expected output: `123456789012 lookahead-123456789012` (your account id). If CloudShell restarts, run this block again.

## 1. Get the code into CloudShell

The GitHub repository is private, so neither CloudShell nor EC2 can clone it anonymously. Build a tarball on your laptop and upload it.

On your **laptop**, in the repo:

```sh
git fetch origin && git archive --format=tar.gz -o lookahead.tgz origin/claude/lookahead-bootstrap-data-lk91zn
ls -lh lookahead.tgz
```

In **CloudShell**: Actions → **Upload file** → `lookahead.tgz`. Then:

```sh
mkdir -p ~/lookahead && tar -xzf ~/lookahead.tgz -C ~/lookahead && ls ~/lookahead/scripts/aws
```

Expected output: `create-table.ts  deploy-ec2.md  ec2-trust-policy.json  iam-policy.json  user-data.sh`.

## 2. Bedrock: which Claude models this account can use

```sh
aws bedrock list-inference-profiles --region us-east-1 \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId, 'anthropic.claude')].[inferenceProfileId,status]" \
  --output table
```

Expected output: a table of `us.anthropic.claude-…` (and maybe `global.anthropic.claude-…`) profile ids, each `ACTIVE`. Pick a Claude **Haiku** profile (the fastest), else Sonnet. The app does the same ranking when `BEDROCK_MODEL_ID` is empty:

```sh
pick() { aws bedrock list-inference-profiles --region us-east-1 \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId, 'anthropic.claude') && contains(inferenceProfileId, '$1')].inferenceProfileId" \
  --output text | tr '\t' '\n' | grep '^us\.' | sort -r | head -1; }
export PROFILE_ID=$(pick haiku); [ -n "$PROFILE_ID" ] || export PROFILE_ID=$(pick sonnet)
export MODEL_ID=${PROFILE_ID#*.}
echo "profile=$PROFILE_ID model=$MODEL_ID"
```

Smoke test. Converse is the API the app uses:

```sh
aws bedrock-runtime converse --region us-east-1 --model-id "$PROFILE_ID" \
  --messages '[{"role":"user","content":[{"text":"Reply with the single word OK."}]}]' \
  --query 'output.message.content[0].text' --output text
```

Expected output: `OK`.

**Fallback.**
- `PROFILE_ID` is empty, or the smoke test fails with `AccessDeniedException` ("You don't have access to the model…"): Claude is not enabled in this account. Set `NARRATION=off` in step 7, or just leave it on: every Explain button then shows the deterministic **TEMPLATE** text. Nothing else changes.
- `ValidationException … on-demand throughput isn't supported`: you passed a bare model id. Use the `us.` profile id.

## 3. DynamoDB table (action log)

```sh
aws dynamodb create-table --region $AWS_REGION --table-name $TABLE_NAME \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=N \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST --query TableDescription.TableStatus --output text
aws dynamodb wait table-exists --region $AWS_REGION --table-name $TABLE_NAME
aws dynamodb describe-table --region $AWS_REGION --table-name $TABLE_NAME \
  --query 'Table.[TableName,TableStatus,BillingModeSummary.BillingMode]' --output text
```

Expected output: `CREATING`, then `lookahead-log  ACTIVE  PAY_PER_REQUEST`.

From a laptop with AWS credentials you can run the equivalent script instead: `pnpm aws:create-table --table lookahead-log --region us-east-1`. It is idempotent and checks the key schema.

**Fallback.** `AccessDeniedException` on CreateTable: use `STORE=file` in step 7 and skip the DynamoDB statement in step 5. The action log then lives on the instance disk in `/var/lib/lookahead/live`. The demo behaves identically. You lose the multi-server conditional-write guarantee, which a single instance does not need.

## 4. S3 bucket (code tarball + audit archive)

```sh
aws s3 mb s3://$BUCKET --region $AWS_REGION
aws s3 cp ~/lookahead.tgz s3://$BUCKET/code/lookahead.tgz
```

Expected output: `make_bucket: lookahead-123456789012`, then `upload: ./lookahead.tgz to s3://lookahead-…/code/lookahead.tgz`.

**Fallback.** If `mb` is denied, set `AUDIT_BUCKET=""` in step 7, and deliver the code with scp (step 9, option C).

## 5. IAM role + instance profile for the instance

```sh
cd ~/lookahead/scripts/aws
sed -e "s|REGION|$AWS_REGION|g; s|ACCOUNT_ID|$ACCOUNT_ID|g; s|TABLE_NAME|$TABLE_NAME|g; s|BUCKET|$BUCKET|g; s|PROFILE_ID|$PROFILE_ID|g; s|MODEL_ID|$MODEL_ID|g" \
  iam-policy.json > /tmp/lookahead-policy.json && cat /tmp/lookahead-policy.json
aws iam create-role --role-name lookahead-ec2 --assume-role-policy-document file://ec2-trust-policy.json --query Role.Arn --output text
aws iam put-role-policy --role-name lookahead-ec2 --policy-name lookahead --policy-document file:///tmp/lookahead-policy.json
aws iam create-instance-profile --instance-profile-name lookahead-ec2 --query InstanceProfile.Arn --output text
aws iam add-role-to-instance-profile --instance-profile-name lookahead-ec2 --role-name lookahead-ec2
sleep 15   # IAM propagation before run-instances can use the profile
```

Expected output: the rendered policy, then `arn:aws:iam::<acct>:role/lookahead-ec2` and `arn:aws:iam::<acct>:instance-profile/lookahead-ec2`.

What the policy grants (`iam-policy.json`):

| Statement | Actions | Resource |
| --- | --- | --- |
| Action log | `dynamodb:PutItem`, `Query`, `DeleteItem`, `ConditionCheckItem` | the table |
| Narration | `bedrock:InvokeModel` | the chosen inference profile + its foundation model in any region the profile routes to |
| Discovery | `bedrock:ListInferenceProfiles` | `*` (list calls have no resource) |
| Audit archive | `s3:PutObject` | `BUCKET/lookahead/*` |
| Code download | `s3:GetObject` | `BUCKET/code/*` |

There is no separate `dynamodb:TransactWriteItems` or `bedrock:Converse` IAM action. Each `Put` inside a TransactWriteItems is authorized as `dynamodb:PutItem`, and Converse is authorized as `bedrock:InvokeModel`.

**Fallback.** `AccessDenied` on `iam:CreateRole` (common in event accounts):
1. Look for a role the event already provides: `aws iam list-instance-profiles --query 'InstanceProfiles[].InstanceProfileName' --output text`. Use its name in step 8 (it may lack DynamoDB/Bedrock rights; the app then degrades by itself).
2. Or launch without `--iam-instance-profile`. Set `STORE=file` and `NARRATION=off` in step 7, and use a presigned code URL (step 9, option B).

## 6. Security group: 80 from anywhere, 22 from your IP

```sh
export VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text); echo $VPC_ID
export SG_ID=$(aws ec2 create-security-group --group-name lookahead-web --description "Lookahead demo: 80 public, 22 admin" \
  --vpc-id $VPC_ID --query GroupId --output text); echo $SG_ID
aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 80 --cidr 0.0.0.0/0 --query Return
export MY_IP=203.0.113.7   # <-- your laptop's address: run `curl https://checkip.amazonaws.com` ON THE LAPTOP
aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 22 --cidr $MY_IP/32 --query Return
```

Expected output: `vpc-…`, `sg-…`, `true`, `true`.

**Notes.**
- `VPC_ID` prints `None`: the account has no default VPC. Run `aws ec2 create-default-vpc` and repeat.
- To SSH from CloudShell instead of the laptop, use CloudShell's address: `curl -s https://checkip.amazonaws.com` run in CloudShell.

## 7. Configure the user data

```sh
cd ~/lookahead/scripts/aws
sed -e "s|^CODE_SOURCE=.*|CODE_SOURCE=\"s3://$BUCKET/code/lookahead.tgz\"|" \
    -e "s|^STORE=.*|STORE=\"dynamo\"|" \
    -e "s|^TABLE_NAME=.*|TABLE_NAME=\"$TABLE_NAME\"|" \
    -e "s|^BEDROCK_MODEL_ID=.*|BEDROCK_MODEL_ID=\"$PROFILE_ID\"|" \
    -e "s|^NARRATION=.*|NARRATION=\"on\"|" \
    -e "s|^AUDIT_BUCKET=.*|AUDIT_BUCKET=\"$BUCKET\"|" \
    -e "s|^LEAD_PIN=.*|LEAD_PIN=\"2026\"|" \
    user-data.sh > /tmp/user-data.sh
grep -E '^(CODE_SOURCE|STORE|TABLE_NAME|BEDROCK_MODEL_ID|NARRATION|AUDIT_BUCKET|LEAD_PIN)=' /tmp/user-data.sh
```

Expected output: the seven lines with your values.
- Fallbacks from earlier steps: change `STORE="dynamo"` to `"file"` and/or `NARRATION="on"` to `"off"`.
- `BEDROCK_MODEL_ID` pins the instance to the same profile the IAM policy grants.
- Change `LEAD_PIN` if you like; tell your clinical-lead phone holder.

## 8. Launch

```sh
export KEY_NAME=lookahead
aws ec2 create-key-pair --key-name $KEY_NAME --query KeyMaterial --output text > ~/$KEY_NAME.pem && chmod 400 ~/$KEY_NAME.pem
export INSTANCE_ID=$(aws ec2 run-instances --region $AWS_REGION \
  --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --instance-type t3.medium --key-name $KEY_NAME --security-group-ids $SG_ID \
  --iam-instance-profile Name=lookahead-ec2 \
  --metadata-options HttpTokens=required \
  --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3}' \
  --user-data file:///tmp/user-data.sh \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=lookahead}]' \
  --query 'Instances[0].InstanceId' --output text); echo $INSTANCE_ID
aws ec2 wait instance-running --instance-ids $INSTANCE_ID
export PUBLIC_DNS=$(aws ec2 describe-instances --instance-ids $INSTANCE_ID --query 'Reservations[0].Instances[0].PublicDnsName' --output text)
echo "http://$PUBLIC_DNS/"
```

Expected output: `i-…`, then `http://ec2-…compute-1.amazonaws.com/`.
- `Invalid IAM Instance Profile name`: IAM had not propagated yet. Wait 10 s and rerun the `run-instances` line.
- `t3.medium` is refused: use `t3.small`. The script adds 2 GB of swap for the build.
- For Graviton, use `t4g.medium` with the AMI parameter ending `-arm64`.
- No instance profile (step 5 fallback): delete the `--iam-instance-profile` line.

## 9. Wait for the build, then check health

The user data installs Node 20 (official tarball, checksum verified) and pnpm 10.28.0. It then runs `pnpm install --frozen-lockfile && pnpm --filter web build` and starts `next start -p 80` under systemd. This takes about 6–8 minutes.

```sh
until curl -fsS -m 5 http://$PUBLIC_DNS/api/health; do sleep 15; done; echo
```

Expected output (one line of JSON, values from your account):

```json
{"ok":true,"store":"dynamo (lookahead-log)","bedrock":"available","bedrockModel":"us.anthropic.claude-haiku-…","bedrockReason":null,
 "dataset":{"key":"ds-707cfece47f4413a","label":"data/raw (reference package)","source":"raw","events":1164},
 "datasetVersion":1,"version":1,"clock":{"nowMs":1773786000000,"mode":"paused","speed":1},"logSeq":0,"conflictsResolved":0,
 "bootWarnings":[],"publicOrigin":"http://ec2-….compute-1.amazonaws.com"}
```

If a service is unavailable, health says so and the app keeps working:
- DynamoDB unavailable: `"store":"file (dynamo unavailable: AccessDeniedException: …)"`.
- Bedrock unavailable: `"bedrock":"unavailable","bedrockReason":"…"`.

Watch the build over SSH: `ssh -i ~/lookahead.pem ec2-user@$PUBLIC_DNS 'sudo tail -f /var/log/lookahead-setup.log'`. The last line is `=== open http://…/ ===`.

**Code delivery options** (`CODE_SOURCE` in user-data.sh):
- **A. S3 + instance profile** (default above).
- **B. Presigned URL, no instance profile needed:** `aws s3 presign s3://$BUCKET/code/lookahead.tgz --expires-in 7200`. Paste the URL as `CODE_SOURCE`.
- **C. scp:** `scp -i ~/lookahead.pem ~/lookahead.tgz ec2-user@$PUBLIC_DNS:` and set `CODE_SOURCE="/home/ec2-user/lookahead.tgz"`. Then run the script by hand: `scp -i ~/lookahead.pem /tmp/user-data.sh ec2-user@$PUBLIC_DNS: && ssh -i ~/lookahead.pem ec2-user@$PUBLIC_DNS 'sudo bash user-data.sh'`.
- **D. Public repo:** if you make the repository public, use `CODE_SOURCE="https://github.com/MaharshKhatri/Lookahead-Sevaro-Health-Hack.git"`.

## 10. Verify the demo path against the deployed URL (from the laptop)

```sh
PLAYWRIGHT_BASE_URL=http://<public-dns> E2E_LEAD_PIN=2026 pnpm --filter web e2e:remote
```

Expected output: `3 passed` (the `@demo` tests: closed loop with the lead briefing, live inject re-rank, decline → escalation suggested). **This resets the demo state on the server.**

## Operating the instance

| Task | Command (on the instance: `ssh -i ~/lookahead.pem ec2-user@$PUBLIC_DNS`) |
| --- | --- |
| Status / logs | `systemctl status lookahead` · `journalctl -u lookahead -f` |
| Switch to file store or template-only | `sudo sed -i 's/^STORE=.*/STORE=file/; s/^NARRATION=.*/NARRATION=off/' /etc/lookahead.env && sudo systemctl restart lookahead` |
| Change the lead PIN | `sudo sed -i 's/^LEAD_PIN=.*/LEAD_PIN=4321/' /etc/lookahead.env && sudo systemctl restart lookahead` |
| Reset between judge groups | **Reset 18:20** in the top bar, or `curl -X POST http://$PUBLIC_DNS/api/demo/reset` (archives the audit to S3 first when `AUDIT_BUCKET` is set) |
| Redeploy new code | Laptop: new `git archive` → CloudShell upload → `aws s3 cp ~/lookahead.tgz s3://$BUCKET/code/lookahead.tgz`. Instance: `TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'); curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/user-data \| sudo bash`. Keeps the offer-link secret and the live log; the previous release stays in `/opt/lookahead-releases/` for rollback. |
| Roll back | `sudo ln -sfn /opt/lookahead-releases/<previous> /opt/lookahead && sudo systemctl restart lookahead` |

## Teardown

The event account is wiped on Monday; to clean up earlier:

```sh
aws ec2 terminate-instances --instance-ids $INSTANCE_ID --query 'TerminatingInstances[0].CurrentState.Name' --output text
aws dynamodb delete-table --table-name $TABLE_NAME --query TableDescription.TableStatus --output text
aws s3 rb s3://$BUCKET --force
aws iam remove-role-from-instance-profile --instance-profile-name lookahead-ec2 --role-name lookahead-ec2
aws iam delete-instance-profile --instance-profile-name lookahead-ec2
aws iam delete-role-policy --role-name lookahead-ec2 --policy-name lookahead && aws iam delete-role --role-name lookahead-ec2
aws ec2 wait instance-terminated --instance-ids $INSTANCE_ID && aws ec2 delete-security-group --group-id $SG_ID
aws ec2 delete-key-pair --key-name $KEY_NAME
```
