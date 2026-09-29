const https = require('https');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TV_APP_KEY = '4409e2ce8ffd12b8';
const TV_APP_SEC = '59b43e04ad6965f34319062b478f83dd';

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function signParams(params) {
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return sorted + '&sign=' + md5(sorted + TV_APP_SEC);
}

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

// Simple fetch — no cookies needed for passport/tv APIs
function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const mod = parsedUrl.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': UA,
      'Referer': 'https://www.bilibili.com/',
      ...(options.headers || {})
    };
    if (options.cookie) headers['Cookie'] = options.cookie;

    const req = mod.request(parsedUrl, {
      method: options.method || 'GET',
      headers
    }, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve({ status: response.statusCode, data, headers: response.headers }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Fetch video page HTML → extract __INITIAL_STATE__ (bypasses 412!)
function fetchVideoPage(bvid) {
  return new Promise((resolve, reject) => {
    const url = `https://www.bilibili.com/video/${bvid}/`;
    const req = https.request(url, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://www.bilibili.com/',
        'Accept-Encoding': 'gzip, deflate'
      }
    }, (res) => {
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

      let html = '';
      stream.on('data', c => html += c);
      stream.on('end', () => {
        const match = html.match(/window\.__INITIAL_STATE__=([\s\S]*?);\(function/);
        if (match) {
          try {
            const state = JSON.parse(match[1]);
            resolve(state.videoData);
          } catch(e) {
            reject(new Error('Failed to parse video state'));
          }
        } else {
          reject(new Error('Video page did not contain state data'));
        }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// TV API playurl — no cookies needed, no 412!
function fetchTvPlayUrl(aid, cid, qn) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const query = `appkey=${TV_APP_KEY}&build=106500&cid=${cid}&device=android&fnval=4048&fnver=0&fourk=1&mid=0&mobi_app=android_tv_yst&object_id=${aid}&platform=android&playurl_type=1&qn=${qn || '120'}&ts=${ts}`;
  const sign = md5(query + TV_APP_SEC);
  return fetchUrl(`https://api.snm0516.aisee.tv/x/tv/playurl?${query}&sign=${sign}`);
}

module.exports = async (req, res) => {
  corsHeaders(res);
  
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const pathParts = req.query?.path || [];
    const path = Array.isArray(pathParts) ? pathParts.join('/') : url.pathname.replace(/^\/api\//, '');
    let result;

    // === VIDEO INFO (from HTML page — bypasses 412) ===
    if (path === 'video/info') {
      const bvid = req.query.bvid || url.searchParams.get('bvid');
      const aid = req.query.aid || url.searchParams.get('aid');
      if (!bvid && !aid) return res.status(400).json({ error: 'Missing bvid or aid' });
      
      try {
        const videoData = await fetchVideoPage(bvid || `av${aid}`);
        return res.json({ code: 0, data: videoData });
      } catch(e) {
        return res.status(500).json({ code: -1, error: e.message });
      }
    }

    // === PLAY URL (TV API — no 412) ===
    else if (path === 'video/playurl') {
      const aid = req.query.aid || url.searchParams.get('aid');
      const cid = req.query.cid || url.searchParams.get('cid');
      const qn = req.query.qn || url.searchParams.get('qn') || '120';
      if (!aid || !cid) return res.status(400).json({ error: 'Missing aid or cid' });
      
      result = await fetchTvPlayUrl(aid, cid, qn);
    }

    // === GENERIC PROXY (for other APIs) ===
    else if (path === 'proxy') {
      const targetUrl = req.query.url || url.searchParams.get('url');
      if (!targetUrl) return res.status(400).json({ error: 'Missing url' });
      const cookie = req.headers['x-cookie'] || '';
      result = await fetchUrl(targetUrl, { cookie });
    }

    // === LOGIN ===
    else if (path === 'login/web/qr/generate') {
      result = await fetchUrl('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
    }
    else if (path === 'login/web/qr/poll') {
      const key = req.query.qrcode_key || url.searchParams.get('qrcode_key');
      result = await fetchUrl(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${key}`);
    }
    else if (path === 'login/tv/qr/generate') {
      const params = { appkey: TV_APP_KEY, local_id: '0', ts: Math.floor(Date.now() / 1000).toString() };
      result = await fetchUrl('https://passport.snm0516.aisee.tv/x/passport-tv-login/qrcode/auth_code', {
        method: 'POST', body: signParams(params),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
    }
    else if (path === 'login/tv/qr/poll') {
      const auth_code = req.query.auth_code || url.searchParams.get('auth_code');
      const params = { appkey: TV_APP_KEY, auth_code, local_id: '0', ts: Math.floor(Date.now() / 1000).toString() };
      result = await fetchUrl('https://passport.bilibili.com/x/passport-tv-login/qrcode/poll', {
        method: 'POST', body: signParams(params),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
    }

    // === USER NAV ===
    else if (path === 'user/nav') {
      const cookie = req.headers['x-cookie'] || '';
      result = await fetchUrl('https://api.bilibili.com/x/web-interface/nav', { cookie });
    }

    // === STREAM PROXY ===
    else if (path === 'stream') {
      const streamUrl = req.query.url || url.searchParams.get('url');
      if (!streamUrl) return res.status(400).json({ error: 'Missing url' });
      const parsedUrl = new URL(streamUrl);
      const mod = parsedUrl.protocol === 'https:' ? https : http;
      const proxyReq = mod.request(parsedUrl, {
        headers: {
          'User-Agent': UA,
          'Referer': 'https://www.bilibili.com/',
          ...(req.headers.range ? { Range: req.headers.range } : {})
        }
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': proxyRes.headers['content-type'] || 'application/octet-stream',
          ...(proxyRes.headers['content-length'] ? { 'Content-Length': proxyRes.headers['content-length'] } : {}),
          ...(proxyRes.headers['content-range'] ? { 'Content-Range': proxyRes.headers['content-range'] } : {}),
          ...(proxyRes.headers['accept-ranges'] ? { 'Accept-Ranges': proxyRes.headers['accept-ranges'] } : {}),
        });
        proxyRes.pipe(res);
      });
      proxyReq.on('error', (e) => res.status(500).json({ error: e.message }));
      proxyReq.end();
      return;
    }
    else {
      return res.status(404).json({ error: 'Not found', path });
    }

    res.setHeader('Content-Type', 'application/json');
    res.status(result.status).send(result.data);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
