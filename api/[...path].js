const https = require('https');
const http = require('http');
const crypto = require('crypto');

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

function getRealCookies() {
  return new Promise((resolve, reject) => {
    const req = https.request('https://www.bilibili.com', {
      method: 'GET',
      headers: { 'User-Agent': UA }
    }, (response) => {
      let cookies = '';
      const setCookies = response.headers['set-cookie'] || [];
      cookies = setCookies.map(c => c.split(';')[0]).join('; ');
      // Consume body
      response.on('data', () => {});
      response.on('end', () => resolve(cookies));
    });
    req.on('error', () => resolve('buvid3=' + crypto.randomUUID() + 'infoc'));
    req.end();
  });
}

let cachedCookies = null;
let cookieTime = 0;

async function getBiliCookies() {
  // Cache cookies for 5 minutes
  if (cachedCookies && Date.now() - cookieTime < 300000) return cachedCookies;
  cachedCookies = await getRealCookies();
  cookieTime = Date.now();
  return cachedCookies;
}

function fetchUrl(url, options = {}) {
  return new Promise(async (resolve, reject) => {
    const biliCookies = await getBiliCookies();
    const parsedUrl = new URL(url);
    const mod = parsedUrl.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': UA,
      'Referer': 'https://www.bilibili.com/',
      ...(options.headers || {})
    };
    
    headers['Cookie'] = options.cookie 
      ? `${options.cookie}; ${biliCookies}` 
      : biliCookies;

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

module.exports = async (req, res) => {
  corsHeaders(res);
  
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    // Vercel passes catch-all as query.path array or in the URL
    const pathParts = req.query?.path || [];
    const path = Array.isArray(pathParts) ? pathParts.join('/') : url.pathname.replace(/^\/api\//, '');
    let result;

    if (path === 'proxy') {
      const targetUrl = req.query.url || url.searchParams.get('url');
      if (!targetUrl) return res.status(400).json({ error: 'Missing url' });
      const cookie = req.headers['x-cookie'] || '';
      result = await fetchUrl(targetUrl, { cookie });
    }
    else if (path === 'login/web/qr/generate') {
      result = await fetchUrl('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
    }
    else if (path === 'login/web/qr/poll') {
      const key = req.query.qrcode_key || url.searchParams.get('qrcode_key');
      result = await fetchUrl(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${key}`);
    }
    else if (path === 'login/tv/qr/generate') {
      const params = {
        appkey: TV_APP_KEY,
        local_id: '0',
        ts: Math.floor(Date.now() / 1000).toString()
      };
      const body = signParams(params);
      result = await fetchUrl('https://passport.snm0516.aisee.tv/x/passport-tv-login/qrcode/auth_code', {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
    }
    else if (path === 'login/tv/qr/poll') {
      const auth_code = req.query.auth_code || url.searchParams.get('auth_code');
      const params = {
        appkey: TV_APP_KEY,
        auth_code,
        local_id: '0',
        ts: Math.floor(Date.now() / 1000).toString()
      };
      const body = signParams(params);
      result = await fetchUrl('https://passport.bilibili.com/x/passport-tv-login/qrcode/poll', {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
    }
    else if (path === 'debug') {
      const biliCookies = await getBiliCookies();
      const testReq = await fetchUrl('https://api.bilibili.com/x/web-interface/view?bvid=BV1WXhn6jEjS');
      return res.json({
        cookies: biliCookies,
        apiStatus: testReq.status,
        apiDataPreview: testReq.data.slice(0, 300)
      });
    }
    else if (path === 'user/nav') {
      const cookie = req.headers['x-cookie'] || '';
      result = await fetchUrl('https://api.bilibili.com/x/web-interface/nav', { cookie });
    }
    else if (path === 'stream') {
      const streamUrl = req.query.url || url.searchParams.get('url');
      if (!streamUrl) return res.status(400).json({ error: 'Missing url' });
      // Stream proxy - pipe directly
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
      return res.status(404).json({ error: 'Not found' });
    }

    res.setHeader('Content-Type', 'application/json');
    res.status(result.status).send(result.data);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
