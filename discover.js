const axios = require('axios');
const os = require('os');
const fs = require('fs');

function getLocalSubnets() {
  const subnets = new Set();
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        subnets.add(iface.address.split('.').slice(0, 3).join('.'));
      }
    }
  }
  return [...subnets];
}

async function scanForRoku(subnet, onProgress) {
  const found = [];
  const checks = [];

  for (let i = 1; i <= 254; i++) {
    const ip = `${subnet}.${i}`;
    checks.push(
      axios.get(`http://${ip}:8060/query/device-info`, { timeout: 800 })
        .then((res) => {
          const name = (res.data.match(/<friendly-device-name>([^<]+)</) || [])[1] || ip;
          const model = (res.data.match(/<model-name>([^<]+)</) || [])[1] || '';
          const device = { ip, name, model };
          found.push(device);
          onProgress?.({ type: 'device', device });
        })
        .catch(() => null)
    );
  }

  await Promise.all(checks);
  return found;
}

async function findInstalledChannels(rokuIp, onProgress) {
  const installed = [];
  const CONCURRENCY = 80;
  const MAX_ID = 3000;

  for (let start = 1; start <= MAX_ID; start += CONCURRENCY) {
    const end = Math.min(start + CONCURRENCY - 1, MAX_ID);
    const batch = [];
    for (let id = start; id <= end; id++) {
      batch.push(
        axios.get(`http://${rokuIp}:8060/query/icon/${id}`, { timeout: 400 })
          .then(() => id)
          .catch(() => null)
      );
    }
    const results = (await Promise.all(batch)).filter(Boolean);
    installed.push(...results);
    onProgress?.({ type: 'scan', start, end, found: results });
  }

  return installed;
}

async function identifyYouTube(rokuIp, channelIds, onProgress) {
  for (const id of channelIds) {
    onProgress?.({ type: 'test', id });
    try {
      await axios.post(`http://${rokuIp}:8060/launch/${id}`, null, { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 2000));
      const res = await axios.get(`http://${rokuIp}:8060/query/active-app`, { timeout: 2000 });
      const appName = (res.data.match(/<app[^>]*>([^<]+)<\/app>/) || [])[1] || '';
      onProgress?.({ type: 'app', id, appName });
      // Match "YouTube" but not "YouTube TV" (different paid service)
      if (/^youtube$/i.test(appName.trim())) {
        return { id, appName };
      }
    } catch (_) { /* continue */ }
  }
  return null;
}

function updateEnv(envPath, updates) {
  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); } catch (_) {}

  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) {
      content = content.replace(re, `${key}=${value}`);
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
  }

  fs.writeFileSync(envPath, content);
}

module.exports = { getLocalSubnets, scanForRoku, findInstalledChannels, identifyYouTube, updateEnv };
