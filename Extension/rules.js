'use strict';
// URL rules: turn a thumbnail or page link into the full-size media URL.
//
// Each rule is { name, match: RegExp, to(m, url) }. to() may return:
//   string                      one candidate URL
//   [string, ...]               candidates tried in order (fallback chain)
//   { src|srcs, type, minWidth } explicit item (type: 'image' | 'video')
//   { items: [...] }            an album of several items
//   { fetch: url, parse }       fetch a page and extract media ('meta' | 'reddit')
//   null                        block: never pop up for this URL
//   undefined                   rule doesn't apply after all; keep looking
(() => {
  const IMG_EXT = /\.(?:jpe?g|jfif|png|gif|webp|avif|bmp|svg|heic)(?:[?#].*)?$/i;
  const VID_EXT = /\.(?:mp4|webm|m4v|mov|ogv)(?:[?#].*)?$/i;

  function editParams(url, fn) {
    try { const u = new URL(url); fn(u.searchParams); return u.href; } catch { return url; }
  }
  const drop = (url, names) => editParams(url, p => names.forEach(n => p.delete(n)));
  const set = (url, k, v) => editParams(url, p => p.set(k, v));

  const IMGUR_RESERVED = /^(?:about|apps|blog|emerald|upload|privacy|rules|random|signin|register|search|gallery|user|hot|new|top)$/i;
  const yt = id => ({
    srcs: ['maxresdefault', 'sddefault', 'hqdefault'].map(n => `https://i.ytimg.com/vi/${id}/${n}.jpg`),
    minWidth: 121 // YouTube serves a 120x90 placeholder for missing sizes
  });

  const builtin = [
    // ---------- link redirects ----------
    { name: 'Image search redirect', match: /[?&](?:imgurl|mediaurl|img_url|imageurl)=([^&#]+)/i,
      to: m => { try { return decodeURIComponent(m[1]); } catch { return undefined; } } },

    // ---------- Imgur ----------
    { name: 'Imgur album', match: /^https?:\/\/(?:m\.)?imgur\.com\/(?:a|gallery|t\/[^/]+)\/[\w-]+/i,
      to: (m, url) => ({ fetch: url, parse: 'meta' }) },
    { name: 'Imgur', match: /^https?:\/\/(?:[im]\.)?imgur\.com\/([a-z0-9]{7}|[a-z0-9]{5})[sbtmlh]?(?:\.(\w+))?(?:[?#].*)?$/i,
      to: m => {
        if (IMGUR_RESERVED.test(m[1])) return undefined;
        const ext = (m[2] || '').toLowerCase();
        if (/^(gifv|mp4|webm)$/.test(ext)) return { type: 'video', src: `https://i.imgur.com/${m[1]}.mp4` };
        return [`https://i.imgur.com/${m[1]}.${ext || 'jpg'}`];
      } },

    // ---------- Reddit ----------
    { name: 'Reddit preview', match: /^https?:\/\/preview\.redd\.it\/([^?#/]+)/i,
      to: (m, url) => {
        let f = m[1]; const k = f.lastIndexOf('-v0-'); if (k >= 0) f = f.slice(k + 4);
        return [`https://i.redd.it/${f}`, url];
      } },
    { name: 'Reddit post', match: /^https?:\/\/(?:(?:www|old|new|np)\.)?reddit\.com\/(?:r\/\w+\/comments|comments|gallery)\/(\w+)/i,
      to: m => ({ fetch: `https://www.reddit.com/comments/${m[1]}.json?raw_json=1`, parse: 'reddit' }) },
    { name: 'Reddit short link', match: /^https?:\/\/redd\.it\/(\w+)\/?$/i,
      to: m => ({ fetch: `https://www.reddit.com/comments/${m[1]}.json?raw_json=1`, parse: 'reddit' }) },

    // ---------- Wikimedia ----------
    { name: 'Wikimedia thumbnail', match: /^(https?:\/\/upload\.wikimedia\.org\/[^/]+\/[^/]+)\/thumb\/(\w\/\w\w\/[^/]+)\/[^/]+$/i,
      to: (m, url) => [`${m[1]}/${m[2]}`, url] },

    // ---------- X / Twitter ----------
    { name: 'Twitter media', match: /^https?:\/\/pbs\.twimg\.com\/media\/([\w-]+)(?:\.(\w+))?(?::\w+)?(?:\?(.*))?$/i,
      to: m => {
        const fmt = m[2] || new URLSearchParams(m[3] || '').get('format') || 'jpg';
        const b = `https://pbs.twimg.com/media/${m[1]}?format=${fmt}&name=`;
        return [b + 'orig', b + '4096x4096', b + 'large'];
      } },
    { name: 'Twitter avatar', match: /^(https?:\/\/pbs\.twimg\.com\/profile_images\/.+?)_(?:normal|bigger|mini|x96|\d+x\d+)(\.\w+)$/i,
      to: m => m[1] + m[2] },

    // ---------- YouTube ----------
    { name: 'YouTube', match: /^https?:\/\/(?:(?:www\.|m\.|music\.)?youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/|i\d?\.ytimg\.com\/(?:vi|vi_webp)\/)([\w-]{11})/i,
      to: m => yt(m[1]) },

    // ---------- avatars & CDNs ----------
    { name: 'GitHub avatar', match: /^https?:\/\/avatars\.githubusercontent\.com\//i,
      to: (m, url) => [set(url, 's', '800'), url] },
    { name: 'Gravatar', match: /^https?:\/\/(?:\w+\.)?gravatar\.com\/avatar\//i,
      to: (m, url) => [set(url, 's', '1024'), url] },
    { name: 'Google user content', match: /^(https?:\/\/(?:lh\d|yt\d)\.(?:googleusercontent|ggpht)\.com\/[^=?#]+)=[\w-]+$/i,
      to: (m, url) => [m[1] + '=s0', url] },
    { name: 'Amazon', match: /^(https?:\/\/(?:m\.media-amazon\.com|images-[\w-]+\.ssl-images-amazon\.com|images\.amazon\.com)\/images\/[A-Z]\/[\w+%-]+)\.[^/]*?_\.(\w+)$/i,
      to: (m, url) => [`${m[1]}.${m[2]}`, url] },
    { name: 'Pinterest', match: /^(https?:\/\/i\.pinimg\.com\/)\d+x(?:\d+)?(?:_\w+)?\/(.+)$/i,
      to: (m, url) => [`${m[1]}originals/${m[2]}`, `${m[1]}736x/${m[2]}`, url] },
    { name: 'Flickr', match: /^(https?:\/\/(?:live|farm\d+)\.staticflickr\.com\/(?:\d+\/)+\d+_[0-9a-f]+)(?:_[a-z])?\.(?:jpg|png|gif)$/i,
      to: (m, url) => [m[1] + '_b.jpg', m[1] + '_c.jpg', url] },
    { name: 'Tumblr', match: /^(https?:\/\/\d+\.media\.tumblr\.com\/.+_)\d+(\.\w+)$/i,
      to: (m, url) => [`${m[1]}1280${m[2]}`, url] },
    { name: 'Tumblr (new)', match: /^(https?:\/\/\d+\.media\.tumblr\.com\/.+\/)s\d+x\d+(?:_c\d)?(\/.+)$/i,
      to: (m, url) => [`${m[1]}s2048x3072${m[2]}`, url] },
    { name: 'Discord', match: /^https?:\/\/media\.discordapp\.net\/(attachments\/[^?#]+)/i,
      to: (m, url) => [drop(url.replace('//media.discordapp.net/', '//cdn.discordapp.com/'), ['width', 'height', 'format', 'quality']), url] },
    { name: 'Giphy page', match: /^https?:\/\/giphy\.com\/(?:gifs|stickers)\/(?:[\w-]*-)?(\w+)\/?$/i,
      to: m => `https://i.giphy.com/media/${m[1]}/giphy.gif` },
    { name: 'Giphy thumb', match: /^https?:\/\/(?:media\d*|i)\.giphy\.com\/media\/(?:v1\.[^/]+\/)?(\w+)\/[\w-]+\.(?:gif|webp|mp4)/i,
      to: m => `https://i.giphy.com/media/${m[1]}/giphy.gif` },
    { name: 'Unsplash', match: /^https?:\/\/(?:images|plus)\.unsplash\.com\//i,
      to: (m, url) => [drop(url, ['w', 'h', 'fit', 'crop', 'dpr', 'q', 'auto', 'fm', 'cs']), url] },
    { name: 'WordPress Photon', match: /^https?:\/\/i\d\.wp\.com\//i,
      to: (m, url) => [drop(url, ['w', 'h', 'resize', 'fit', 'crop', 'zoom']), url] },
    { name: 'WordPress.com', match: /^https?:\/\/[^/]+\.(?:files\.)?wordpress\.com\/.+\.(?:jpe?g|png|gif|webp)\?/i,
      to: (m, url) => [drop(url, ['w', 'h', 'resize', 'fit', 'crop']), url] },
    { name: 'Shopify', match: /^(https?:\/\/[^/]+\/(?:cdn\/shop|s\/files)\/.+?)_(?:\d*x\d*|pico|icon|thumb|small|compact|medium|large|grande)(?:_crop_\w+)?(?:@\dx)?(\.\w+)(?:\?.*)?$/i,
      to: (m, url) => [m[1] + m[2], url] },
    { name: 'Size suffix (-WxH)', match: /^(https?:\/\/.+?)-\d{2,4}x\d{2,4}(\.(?:jpe?g|png|gif|webp))(\?.*)?$/i,
      to: (m, url) => [m[1] + m[2], url] },

    // ---------- pages whose preview image is in their <meta> tags ----------
    { name: 'Page preview', match: /^https?:\/\/(?:www\.)?(?:instagram\.com\/(?:[\w.]+\/)?(?:p|reel)\/[\w-]+|flickr\.com\/photos\/[\w@-]+\/\d+|deviantart\.com\/[\w-]+\/art\/[\w-]+|artstation\.com\/artwork\/\w+|[a-z-]+\.(?:m\.)?wikipedia\.org\/wiki\/(?:File|Image|Datei|Fichier|Archivo):[^#?]+|commons\.wikimedia\.org\/wiki\/File:[^#?]+|dribbble\.com\/shots\/\d+|imgflip\.com\/i\/\w+|gyazo\.com\/[0-9a-f]{32}|prnt\.sc\/\w+|ibb\.co\/\w+|postimg\.cc\/\w+|streamable\.com\/\w+|500px\.com\/photo\/\d+|vimeo\.com\/\d+)/i,
      to: (m, url) => ({ fetch: url, parse: 'meta' }) },

    // ---------- direct media files ----------
    { name: 'Direct video', match: VID_EXT, to: (m, url) => ({ type: 'video', src: url }) },
    { name: 'Direct image', match: IMG_EXT, to: (m, url) => url }
  ];

  // Custom rules: one per line, "pattern => replacement".
  //   replacement may use $1, $2… and $& (whole match)
  //   "a || b"       try a, then b
  //   "video: url"   force video
  //   "@meta"        fetch the page and use its preview image/video
  //   "@meta: url"   fetch a different page
  //   "!" or empty   never pop up for matching URLs
  function compileUserRules(text) {
    const rules = [], errors = [];
    String(text || '').split('\n').forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) return;
      const k = line.indexOf('=>');
      if (k < 0) { errors.push(`Line ${i + 1}: missing "=>"`); return; }
      let pat = line.slice(0, k).trim();
      const rep = line.slice(k + 2).trim();
      let flags = 'i';
      const lit = /^\/(.+)\/([a-z]*)$/.exec(pat);
      if (lit) { pat = lit[1]; flags = lit[2].replace(/[gy]/g, ''); }
      let re;
      try { re = new RegExp(pat, flags); } catch (e) { errors.push(`Line ${i + 1}: ${e.message}`); return; }
      rules.push({
        name: `Custom rule (line ${i + 1})`, match: re,
        to: (m, url) => {
          const sub = s => s.replace(/\$(\d+|&)/g, (_, g) => g === '&' ? m[0] : (m[+g] ?? ''));
          let r = rep;
          if (r === '' || r === '!') return null;
          if (r === '@meta') return { fetch: url, parse: 'meta' };
          if (/^@meta:/i.test(r)) return { fetch: sub(r.slice(6).trim()), parse: 'meta' };
          let type;
          if (/^video:/i.test(r)) { type = 'video'; r = r.slice(6).trim(); }
          return { srcs: r.split('||').map(s => sub(s.trim())).filter(Boolean), type };
        }
      });
    });
    return { rules, errors };
  }

  globalThis.HoverLensRules = { builtin, compileUserRules, IMG_EXT, VID_EXT };
})();
