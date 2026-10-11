/** Theme keys and the no-flash script (plain module so the server layout can inline the string; see theme.tsx). */
export const THEME_KEY = 'lh-theme';
export const DENSITY_KEY = 'lh-density';

export const THEME_SCRIPT = `(function(){try{var d=document.documentElement,p=location.pathname,q=new URLSearchParams(location.search).get('theme'),s=null;try{s=localStorage.getItem('${THEME_KEY}')}catch(e){}var t=(q==='day'||q==='night')?q:(s==='day'||s==='night')?s:(/^\\/(offer|standby|lead)/.test(p)&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches)?'day':'night';d.setAttribute('data-theme',t);var n=null;try{n=localStorage.getItem('${DENSITY_KEY}')}catch(e){}d.setAttribute('data-density',n==='compact'?'compact':'comfortable')}catch(e){}})();`;

