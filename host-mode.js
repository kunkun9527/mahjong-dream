// Static hosting (GitHub Pages, Cloudflare Pages, app shells) runs the backend inside the page.
// local/server.mjs answers this URL with 'node' so the page uses its /ws and /api/profile instead.
window.__mjHostMode = 'browser';
