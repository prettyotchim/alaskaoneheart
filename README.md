# alaskaoneheart.site

Personal site (visual template). Static HTML, published with GitHub Pages.

`spotify/worker.js` is the Cloudflare Worker behind the now-playing card. It keeps the Spotify client secret and refresh token as Worker secrets, so they never land in this public repo. Its address goes into `NOW_URL` in index.html; without it the card reads Discord presence through Lanyard.
