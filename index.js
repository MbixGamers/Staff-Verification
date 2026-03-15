require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// CONFIGURATION: Replace these with your actual IDs
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || '';
const REDIRECT_PATH = '/callback';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const getRedirectUri = (req) => {
    if (REDIRECT_URI) return REDIRECT_URI;
    const forwardedProto = req.headers['x-forwarded-proto'];
    const proto = forwardedProto ? forwardedProto.split(',')[0].trim() : req.protocol;
    return `${proto}://${req.get('host')}${REDIRECT_PATH}`;
};

// LIST OF SERVERS AND THE "STAFF" OR "ROSTERED" ROLE IDS YOU WANT TO CHECK
const DEFAULT_TARGET_SERVERS = [
    { guildId: '1351362266246680626', name: 'Void Esports™', staffRoles: ['1444524090491801620', '1482370653825794251'] },
    { guildId: '1456279983407370426', name: 'Void Bot Testing', staffRoles: ['1462124606893850634'] }
];

const DATA_DIR = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : (process.env.RAILWAY_VOLUME_MOUNT_PATH
        ? path.join(path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH), 'data')
        : path.join(__dirname, 'data'));
const TARGET_SERVERS_PATH = path.join(DATA_DIR, 'target-servers.json');
const DM_RECIPIENTS_PATH = path.join(DATA_DIR, 'dm-recipients.json');
const CHANNEL_RECIPIENTS_PATH = path.join(DATA_DIR, 'channel-recipients.json');

const ensureDataFile = () => {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(TARGET_SERVERS_PATH)) {
        fs.writeFileSync(TARGET_SERVERS_PATH, JSON.stringify(DEFAULT_TARGET_SERVERS, null, 2));
    }
};

const loadTargetServers = () => {
    ensureDataFile();
    try {
        const raw = fs.readFileSync(TARGET_SERVERS_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [...DEFAULT_TARGET_SERVERS];
        return parsed.map((item) => ({
            guildId: String(item.guildId || '').trim(),
            name: String(item.name || '').trim(),
            staffRoles: Array.isArray(item.staffRoles) ? item.staffRoles.map((r) => String(r).trim()).filter(Boolean) : []
        })).filter((item) => item.guildId);
    } catch (err) {
        console.warn('Failed to load target servers, using defaults:', err.message);
        return [...DEFAULT_TARGET_SERVERS];
    }
};

const saveTargetServers = (servers) => {
    ensureDataFile();
    fs.writeFileSync(TARGET_SERVERS_PATH, JSON.stringify(servers, null, 2));
};

let targetServers = loadTargetServers();

const getTargetServers = () => {
    targetServers = loadTargetServers();
    return targetServers;
};

// USER IDS TO DM WITH VERIFICATION STATUS
const DEFAULT_DM_RECIPIENTS = [
    '928635423465537579',
    '1385881439102439484'
];
const DEFAULT_CHANNEL_RECIPIENTS = [];

const ensureDmRecipientsFile = () => {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(DM_RECIPIENTS_PATH)) {
        fs.writeFileSync(DM_RECIPIENTS_PATH, JSON.stringify(DEFAULT_DM_RECIPIENTS, null, 2));
    }
};

const ensureChannelRecipientsFile = () => {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(CHANNEL_RECIPIENTS_PATH)) {
        fs.writeFileSync(CHANNEL_RECIPIENTS_PATH, JSON.stringify(DEFAULT_CHANNEL_RECIPIENTS, null, 2));
    }
};

const loadDmRecipients = () => {
    ensureDmRecipientsFile();
    try {
        const raw = fs.readFileSync(DM_RECIPIENTS_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [...DEFAULT_DM_RECIPIENTS];
        return parsed.map((item) => String(item || '').trim()).filter(Boolean);
    } catch (err) {
        console.warn('Failed to load DM recipients, using defaults:', err.message);
        return [...DEFAULT_DM_RECIPIENTS];
    }
};

const saveDmRecipients = (recipients) => {
    ensureDmRecipientsFile();
    fs.writeFileSync(DM_RECIPIENTS_PATH, JSON.stringify(recipients, null, 2));
};

let dmRecipients = loadDmRecipients();
const dmSendStatus = new Map();

const loadChannelRecipients = () => {
    ensureChannelRecipientsFile();
    try {
        const raw = fs.readFileSync(CHANNEL_RECIPIENTS_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [...DEFAULT_CHANNEL_RECIPIENTS];
        return parsed.map((item) => String(item || '').trim()).filter(Boolean);
    } catch (err) {
        console.warn('Failed to load channel recipients, using defaults:', err.message);
        return [...DEFAULT_CHANNEL_RECIPIENTS];
    }
};

const saveChannelRecipients = (recipients) => {
    ensureChannelRecipientsFile();
    fs.writeFileSync(CHANNEL_RECIPIENTS_PATH, JSON.stringify(recipients, null, 2));
};

let channelRecipients = loadChannelRecipients();
const channelSendStatus = new Map();
const scanResults = new Map();
const SCAN_TTL_MS = 1000 * 60 * 10;
const GUILD_SCAN_DELAY_MS = Number(process.env.GUILD_SCAN_DELAY_MS) || 5000;
const RATE_LIMIT_BACKOFF_MS = Number(process.env.RATE_LIMIT_BACKOFF_MS) || 4000;

const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const adminSessions = new Map();

const parseCookies = (cookieHeader) => {
    const cookies = {};
    if (!cookieHeader) return cookies;
    const parts = cookieHeader.split(';');
    for (const part of parts) {
        const [rawKey, ...rest] = part.trim().split('=');
        if (!rawKey) continue;
        const key = rawKey.trim();
        const value = rest.join('=').trim();
        cookies[key] = decodeURIComponent(value);
    }
    return cookies;
};

const getAdminSession = (req) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies.admin_session || '';
    if (!token) return null;
    const session = adminSessions.get(token);
    if (!session) return null;
    if (Date.now() - session.createdAt > ADMIN_SESSION_TTL_MS) {
        adminSessions.delete(token);
        return null;
    }
    return session;
};

const requireAdmin = (req, res, next) => {
    if (!getAdminSession(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
};

const sendStatusDm = async (recipientId, message) => {
    if (!BOT_TOKEN) {
        console.warn('DISCORD_BOT_TOKEN not set. Skipping DM.');
        return;
    }
    const dmChannelResponse = await axios.post(
        'https://discord.com/api/users/@me/channels',
        { recipient_id: recipientId },
        { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
    );
    const channelId = dmChannelResponse.data.id;
    await axios.post(
        `https://discord.com/api/channels/${channelId}/messages`,
        { content: message },
        { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
    );
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sendStatusDmWithRetry = async (recipientId, message, maxAttempts = 3) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            await sendStatusDm(recipientId, message);
            return { ok: true };
        } catch (err) {
            const status = err.response?.status;
            const retryAfter = err.response?.data?.retry_after;
            if (status === 429) {
                const waitMs = Math.max(500, Math.ceil((Number(retryAfter) || 1) * 1000));
                console.warn(`Rate limited when DMing ${recipientId}. Waiting ${waitMs}ms before retry.`);
                await sleep(waitMs);
                continue;
            }
            return { ok: false, error: err.response?.data || err.message };
        }
    }
    return { ok: false, error: 'Rate limited too many times.' };
};

const recordDmStatus = (recipientId, ok, error) => {
    dmSendStatus.set(recipientId, {
        ok,
        error: error || null,
        at: new Date().toISOString()
    });
};

const sendChannelMessage = async (channelId, message) => {
    if (!BOT_TOKEN) {
        console.warn('DISCORD_BOT_TOKEN not set. Skipping channel message.');
        return;
    }
    await axios.post(
        `https://discord.com/api/channels/${channelId}/messages`,
        { content: message },
        { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
    );
};

const sendChannelMessageWithRetry = async (channelId, message, maxAttempts = 3) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            await sendChannelMessage(channelId, message);
            return { ok: true };
        } catch (err) {
            const status = err.response?.status;
            const retryAfter = err.response?.data?.retry_after;
            if (status === 429) {
                const waitMs = Math.max(500, Math.ceil((Number(retryAfter) || 1) * 1000));
                console.warn(`Rate limited when posting to channel ${channelId}. Waiting ${waitMs}ms before retry.`);
                await sleep(waitMs);
                continue;
            }
            return { ok: false, error: err.response?.data || err.message };
        }
    }
    return { ok: false, error: 'Rate limited too many times.' };
};

const recordChannelStatus = (channelId, ok, error) => {
    channelSendStatus.set(channelId, {
        ok,
        error: error || null,
        at: new Date().toISOString()
    });
};

const fetchGuildMemberWithRetry = async (accessToken, guildId, maxAttempts = 5, onRateLimit) => {
    const memberUrl = `https://discord.com/api/users/@me/guilds/${guildId}/member`;
    let extraBackoff = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const response = await axios.get(memberUrl, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            return response;
        } catch (err) {
            const status = err.response?.status;
            const retryAfter = err.response?.data?.retry_after;
            if (status === 429) {
                const baseWaitMs = Math.max(500, Math.ceil((Number(retryAfter) || 1) * 1000));
                const waitMs = baseWaitMs + extraBackoff;
                console.warn(`Rate limited reading guild ${guildId}. Waiting ${waitMs}ms before retry.`);
                if (typeof onRateLimit === 'function') {
                    onRateLimit(waitMs);
                }
                await sleep(waitMs);
                extraBackoff = Math.min(RATE_LIMIT_BACKOFF_MS * attempt, 10000);
                continue;
            }
            throw err;
        }
    }
    const error = new Error('Rate limited too many times.');
    error.code = 429;
    throw error;
};

const scheduleScanCleanup = (scanId) => {
    setTimeout(() => {
        scanResults.delete(scanId);
    }, SCAN_TTL_MS);
};

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Staff Verification</title>
                <style>
                    :root {
                        --bg-1: #0f172a;
                        --bg-2: #0b2f4b;
                        --bg-3: #113d5c;
                        --card: rgba(255, 255, 255, 0.08);
                        --card-border: rgba(255, 255, 255, 0.2);
                        --text: #e2e8f0;
                        --muted: #94a3b8;
                        --accent: #38bdf8;
                        --accent-2: #22d3ee;
                    }
                    * {
                        box-sizing: border-box;
                    }
                    body {
                        margin: 0;
                        min-height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        background: radial-gradient(1200px circle at 20% 10%, #1e3a8a 0%, transparent 55%),
                                    radial-gradient(1000px circle at 80% 20%, #0ea5e9 0%, transparent 45%),
                                    linear-gradient(135deg, var(--bg-1), var(--bg-2), var(--bg-3));
                        color: var(--text);
                        font-family: "Sora", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
                    }
                    .card {
                        width: min(520px, 92vw);
                        padding: 40px 36px;
                        border-radius: 16px;
                        background: var(--card);
                        border: 1px solid var(--card-border);
                        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
                        text-align: center;
                        backdrop-filter: blur(12px);
                    }
                    h1 {
                        margin: 0 0 12px 0;
                        font-size: 28px;
                        letter-spacing: 0.2px;
                    }
                    p {
                        margin: 0 0 24px 0;
                        color: var(--muted);
                        font-size: 15px;
                        line-height: 1.5;
                    }
                    .button {
                        display: inline-block;
                        padding: 12px 22px;
                        border-radius: 999px;
                        border: 0;
                        background: linear-gradient(120deg, var(--accent), var(--accent-2));
                        color: #0b1220;
                        font-weight: 700;
                        font-size: 14px;
                        letter-spacing: 0.3px;
                        text-decoration: none;
                        box-shadow: 0 10px 24px rgba(34, 211, 238, 0.35);
                        transition: transform 160ms ease, box-shadow 160ms ease;
                    }
                    .button:hover {
                        transform: translateY(-2px);
                        box-shadow: 0 14px 30px rgba(56, 189, 248, 0.45);
                    }
                    .footer {
                        margin-top: 20px;
                        font-size: 12px;
                        color: var(--muted);
                    }
                    .admin-link {
                        position: fixed;
                        top: 18px;
                        right: 18px;
                        display: inline-flex;
                        align-items: center;
                        gap: 8px;
                        font-size: 13px;
                        text-decoration: none;
                        color: var(--text);
                        padding: 8px 14px;
                        border-radius: 999px;
                        border: 1px solid rgba(255, 255, 255, 0.24);
                        background: rgba(15, 23, 42, 0.75);
                        font-weight: 700;
                        letter-spacing: 0.3px;
                        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.25);
                        transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease;
                        z-index: 10;
                    }
                    .admin-link:hover {
                        transform: translateY(-1px);
                        box-shadow: 0 14px 30px rgba(0, 0, 0, 0.35);
                        border-color: rgba(255, 255, 255, 0.5);
                    }
                    .admin-icon {
                        font-size: 14px;
                    }
                </style>
            </head>
            <body>
                <a class="admin-link" href="/admin" aria-label="Admin login">
                    <span class="admin-icon">🔒</span>
                    <span>Admin</span>
                </a>
                <div class="card">
                    <h1>Staff Verification</h1>
                    <p>Verify your roster status across approved servers and receive an instant result.</p>
                    <p style="margin-top:8px;">Note: This action can take 15+ minutes due to Discord rate limits.</p>
                    <a class="button" href="/login">Login with Discord</a>
                    <div class="footer">Secure OAuth2 verification</div>
                </div>
            </body>
        </html>
    `);
});

app.get('/admin', (req, res) => {
    const isAuthed = Boolean(getAdminSession(req));
    const needsCreds = !ADMIN_USERNAME || !ADMIN_PASSWORD;
    res.send(`
        <html>
            <head>
                <title>Admin Setup</title>
                <style>
                    :root {
                        --bg-1: #0b1120;
                        --bg-2: #10203a;
                        --bg-3: #162f4a;
                        --card: rgba(255, 255, 255, 0.06);
                        --card-border: rgba(255, 255, 255, 0.18);
                        --text: #e2e8f0;
                        --muted: #94a3b8;
                        --accent: #f97316;
                        --accent-2: #facc15;
                        --danger: #f43f5e;
                        --good: #22c55e;
                    }
                    * { box-sizing: border-box; }
                    body {
                        margin: 0;
                        min-height: 100vh;
                        background: radial-gradient(900px circle at 15% 10%, rgba(59, 130, 246, 0.35) 0%, transparent 55%),
                                    radial-gradient(900px circle at 85% 20%, rgba(249, 115, 22, 0.35) 0%, transparent 55%),
                                    linear-gradient(135deg, var(--bg-1), var(--bg-2), var(--bg-3));
                        color: var(--text);
                        font-family: "Plus Jakarta Sans", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
                        padding: 40px 16px 80px;
                    }
                    .wrap {
                        max-width: 980px;
                        margin: 0 auto;
                        display: grid;
                        gap: 18px;
                    }
                    .card {
                        padding: 24px;
                        border-radius: 16px;
                        background: var(--card);
                        border: 1px solid var(--card-border);
                        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
                        backdrop-filter: blur(10px);
                    }
                    h1 { margin: 0 0 8px 0; font-size: 28px; }
                    h2 { margin: 0 0 10px 0; font-size: 18px; }
                    p { margin: 0; color: var(--muted); font-size: 14px; }
                    label { display: block; margin-bottom: 6px; font-size: 13px; color: var(--muted); }
                    input, select {
                        width: 100%;
                        padding: 10px 12px;
                        border-radius: 10px;
                        border: 1px solid rgba(255, 255, 255, 0.12);
                        background: rgba(15, 23, 42, 0.7);
                        color: var(--text);
                        font-size: 14px;
                    }
                    .row { display: grid; gap: 12px; }
                    .row-2 { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
                    .row-3 { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
                    .btn {
                        padding: 10px 16px;
                        border-radius: 999px;
                        border: 0;
                        background: linear-gradient(120deg, var(--accent), var(--accent-2));
                        color: #0b1120;
                        font-weight: 700;
                        font-size: 13px;
                        cursor: pointer;
                        letter-spacing: 0.3px;
                    }
                    .btn.secondary {
                        background: rgba(255, 255, 255, 0.12);
                        color: var(--text);
                    }
                    .btn.danger {
                        background: rgba(244, 63, 94, 0.16);
                        color: #fecdd3;
                        border: 1px solid rgba(244, 63, 94, 0.5);
                    }
                    .pill {
                        display: inline-flex;
                        align-items: center;
                        gap: 6px;
                        padding: 6px 10px;
                        border-radius: 999px;
                        background: rgba(255, 255, 255, 0.12);
                        color: var(--text);
                        font-size: 12px;
                        cursor: pointer;
                    }
                    .pill:hover { background: rgba(244, 63, 94, 0.2); color: var(--danger); }
                    .roles {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 8px;
                        margin-top: 10px;
                    }
                    .muted { color: var(--muted); font-size: 13px; }
                    .notice { padding: 10px 12px; border-radius: 10px; background: rgba(34, 197, 94, 0.15); color: var(--good); font-size: 13px; }
                    .error { padding: 10px 12px; border-radius: 10px; background: rgba(244, 63, 94, 0.15); color: var(--danger); font-size: 13px; }
                    .hidden { display: none; }
                    .section-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
                    .server-row {
                        display: grid;
                        grid-template-columns: 1fr auto;
                        gap: 12px;
                        align-items: center;
                        padding: 12px 14px;
                        border-radius: 12px;
                        border: 1px solid rgba(255, 255, 255, 0.12);
                        background: rgba(15, 23, 42, 0.5);
                    }
                    .server-meta {
                        font-size: 13px;
                        color: var(--muted);
                        margin-top: 4px;
                    }
                    .server-list {
                        display: grid;
                        gap: 10px;
                        margin-top: 10px;
                    }
                    .home-link {
                        position: fixed;
                        top: 18px;
                        left: 18px;
                        display: inline-flex;
                        align-items: center;
                        gap: 8px;
                        font-size: 13px;
                        text-decoration: none;
                        color: var(--text);
                        padding: 8px 14px;
                        border-radius: 999px;
                        border: 1px solid rgba(255, 255, 255, 0.24);
                        background: rgba(15, 23, 42, 0.75);
                        font-weight: 700;
                        letter-spacing: 0.3px;
                        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.25);
                        transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease;
                        z-index: 10;
                    }
                    .home-link:hover {
                        transform: translateY(-1px);
                        box-shadow: 0 14px 30px rgba(0, 0, 0, 0.35);
                        border-color: rgba(255, 255, 255, 0.5);
                    }
                    .home-icon {
                        font-size: 22px;
                        line-height: 1;
                    }
                </style>
            </head>
            <body>
                <a class="home-link" href="/" id="homeLink" aria-label="Home">
                    <span class="home-icon">⌂</span>
                    <span>Home</span>
                </a>
                <div class="wrap">
                    <div class="card">
                        <h1>Admin Setup</h1>
                        <p>Manage target servers and staff roles without editing code.</p>
                        ${needsCreds ? `<div class="error" style="margin-top:12px;">Set ADMIN_USERNAME and ADMIN_PASSWORD in your environment to enable login.</div>` : ''}
                    </div>

                    <div class="card" id="loginCard" ${isAuthed ? 'style="display:none;"' : ''}>
                        <h2>Sign In</h2>
                        <div class="row row-2" style="margin-top:12px;">
                            <div>
                                <label>Username</label>
                                <input id="loginUser" autocomplete="username" />
                            </div>
                            <div>
                                <label>Password</label>
                                <input id="loginPass" type="password" autocomplete="current-password" />
                            </div>
                        </div>
                        <div class="row" style="margin-top:12px;">
                            <button class="btn" id="loginBtn">Login</button>
                            <div id="loginMsg" class="hidden"></div>
                        </div>
                    </div>

                    <div class="card" id="adminCard" ${isAuthed ? '' : 'style="display:none;"'}>
                        <div class="row row-2">
                            <div>
                                <h2>Add Server</h2>
                                <div class="row">
                                    <div>
                                        <label>Server Name</label>
                                        <input id="serverName" placeholder="e.g. Main Roster" />
                                    </div>
                                    <div>
                                        <label>Guild ID</label>
                                        <input id="guildId" placeholder="1234567890" />
                                    </div>
                                    <button class="btn" id="addServerBtn">Add Server</button>
                                    <div id="serverMsg" class="hidden"></div>
                                </div>
                            </div>
                            <div>
                                <h2>Add Role</h2>
                                <div class="row">
                                    <div>
                                        <label>Select Server</label>
                                        <select id="serverSelect"></select>
                                    </div>
                                    <div>
                                        <label>Role ID</label>
                                        <input id="roleId" placeholder="Paste role id and press Enter" />
                                    </div>
                                    <div class="muted">Press Enter to add a role. Click a role to delete it.</div>
                                </div>
                            </div>
                        </div>
                        <div style="margin-top:16px;">
                            <h2>Role List</h2>
                            <div id="roleList" class="roles"></div>
                            <div id="roleCsv" class="muted" style="margin-top:8px;"></div>
                        </div>
                        <div style="margin-top:16px;">
                            <div class="section-title">
                                <h2>Server List</h2>
                                <div class="muted">Delete removes the server and its roles.</div>
                            </div>
                            <div id="serverList" class="server-list"></div>
                        </div>
                        <div style="margin-top:16px;">
                            <button class="btn secondary" id="logoutBtn">Logout</button>
                        </div>
                    </div>

                    <div class="card" id="dmCard" ${isAuthed ? '' : 'style="display:none;"'}>
                        <div class="section-title">
                            <h2>DM Recipients</h2>
                            <div class="muted">Click a user to delete.</div>
                        </div>
                        <div class="row" style="margin-top:10px;">
                            <div>
                                <label>User ID</label>
                                <input id="dmUserId" placeholder="Paste user id and press Enter" />
                            </div>
                        </div>
                        <div id="dmList" class="roles"></div>
                        <div id="dmStatus" class="muted" style="margin-top:10px;"></div>
                    </div>

                    <div class="card" id="channelCard" ${isAuthed ? '' : 'style="display:none;"'}>
                        <div class="section-title">
                            <h2>Channel Recipients</h2>
                            <div class="muted">Click a channel to delete.</div>
                        </div>
                        <div class="row" style="margin-top:10px;">
                            <div>
                                <label>Channel ID</label>
                                <input id="channelId" placeholder="Paste channel id and press Enter" />
                            </div>
                        </div>
                        <div id="channelList" class="roles"></div>
                        <div id="channelStatus" class="muted" style="margin-top:10px;"></div>
                    </div>
                </div>

                <script>
                    const loginCard = document.getElementById('loginCard');
                    const adminCard = document.getElementById('adminCard');
                    const dmCard = document.getElementById('dmCard');
                    const loginMsg = document.getElementById('loginMsg');
                    const serverMsg = document.getElementById('serverMsg');
                    const serverSelect = document.getElementById('serverSelect');
                    const roleList = document.getElementById('roleList');
                    const roleCsv = document.getElementById('roleCsv');
                    const serverList = document.getElementById('serverList');
                    const roleInput = document.getElementById('roleId');
                    const dmInput = document.getElementById('dmUserId');
                    const dmList = document.getElementById('dmList');
                    const dmStatus = document.getElementById('dmStatus');
                    const channelInput = document.getElementById('channelId');
                    const channelList = document.getElementById('channelList');
                    const channelStatus = document.getElementById('channelStatus');
                    const homeLink = document.getElementById('homeLink');

                    const setMsg = (el, text, isError) => {
                        el.textContent = text;
                        el.className = isError ? 'error' : 'notice';
                    };

                    const clearMsg = (el) => {
                        el.textContent = '';
                        el.className = 'hidden';
                    };

                    const fetchServers = async () => {
                        const res = await fetch('/admin/servers');
                        if (!res.ok) {
                            throw new Error('Unauthorized');
                        }
                        return res.json();
                    };

                    const renderServers = (servers) => {
                        serverSelect.innerHTML = '';
                        servers.forEach((server) => {
                            const opt = document.createElement('option');
                            opt.value = server.guildId;
                            opt.textContent = server.name ? server.name + ' (' + server.guildId + ')' : server.guildId;
                            serverSelect.appendChild(opt);
                        });
                        if (!servers.length) {
                            const opt = document.createElement('option');
                            opt.value = '';
                            opt.textContent = 'No servers yet';
                            serverSelect.appendChild(opt);
                        }
                    };

                    const renderRoles = (server) => {
                        roleList.innerHTML = '';
                        if (!server) {
                            roleCsv.textContent = '';
                            return;
                        }
                        const roles = server.staffRoles || [];
                        roleCsv.textContent = roles.join(', ');
                        if (!roles.length) {
                            roleList.innerHTML = '<span class="muted">No roles yet.</span>';
                            return;
                        }
                        roles.forEach((roleId) => {
                            const pill = document.createElement('span');
                            pill.className = 'pill';
                            pill.textContent = roleId;
                            pill.addEventListener('click', async () => {
                                if (!confirm('Delete role ' + roleId + '?')) return;
                                await fetch('/admin/roles', {
                                    method: 'DELETE',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ guildId: server.guildId, roleId })
                                });
                                await refresh();
                            });
                            roleList.appendChild(pill);
                        });
                    };

                    const renderServerList = (servers) => {
                        if (!serverList) return;
                        serverList.innerHTML = '';
                        if (!servers.length) {
                            serverList.innerHTML = '<span class="muted">No servers configured yet.</span>';
                            return;
                        }
                        servers.forEach((server) => {
                            const row = document.createElement('div');
                            row.className = 'server-row';
                            const info = document.createElement('div');
                            const title = document.createElement('div');
                            title.textContent = server.name ? server.name : server.guildId;
                            const meta = document.createElement('div');
                            const roleCount = Array.isArray(server.staffRoles) ? server.staffRoles.length : 0;
                            meta.className = 'server-meta';
                            meta.textContent = 'Guild ID: ' + server.guildId + ' · Roles: ' + roleCount;
                            info.appendChild(title);
                            info.appendChild(meta);
                            const actions = document.createElement('div');
                            const delBtn = document.createElement('button');
                            delBtn.className = 'btn danger';
                            delBtn.textContent = 'Delete';
                            delBtn.addEventListener('click', async () => {
                                if (!confirm('Delete server ' + (server.name || server.guildId) + '?')) return;
                                await fetch('/admin/servers', {
                                    method: 'DELETE',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ guildId: server.guildId })
                                });
                                await refresh();
                            });
                            actions.appendChild(delBtn);
                            row.appendChild(info);
                            row.appendChild(actions);
                            serverList.appendChild(row);
                        });
                    };

                    const renderDmRecipients = (recipients) => {
                        dmList.innerHTML = '';
                        if (!recipients.length) {
                            dmList.innerHTML = '<span class="muted">No DM recipients yet.</span>';
                            return;
                        }
                        recipients.forEach((userId) => {
                            const pill = document.createElement('span');
                            pill.className = 'pill';
                            pill.textContent = userId;
                            pill.addEventListener('click', async () => {
                                if (!confirm('Delete user ' + userId + '?')) return;
                                await fetch('/admin/dm-users', {
                                    method: 'DELETE',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ userId })
                                });
                                await refresh(serverSelect.value);
                            });
                            dmList.appendChild(pill);
                        });
                    };

                    const renderChannelRecipients = (recipients) => {
                        channelList.innerHTML = '';
                        if (!recipients.length) {
                            channelList.innerHTML = '<span class="muted">No channel recipients yet.</span>';
                            return;
                        }
                        recipients.forEach((channelId) => {
                            const pill = document.createElement('span');
                            pill.className = 'pill';
                            pill.textContent = channelId;
                            pill.addEventListener('click', async () => {
                                if (!confirm('Delete channel ' + channelId + '?')) return;
                                await fetch('/admin/channels', {
                                    method: 'DELETE',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ channelId })
                                });
                                await refresh(serverSelect.value);
                            });
                            channelList.appendChild(pill);
                        });
                    };

                    const renderDmStatus = (statusRows) => {
                        if (!dmStatus) return;
                        if (!statusRows.length) {
                            dmStatus.textContent = 'No DM status yet.';
                            return;
                        }
                        const lines = statusRows.map((row) => {
                            if (row.ok) {
                                return row.userId + ': last DM ok at ' + row.at;
                            }
                            const err = row.error?.message || row.error?.error || row.error || 'Unknown error';
                            return row.userId + ': last DM failed (' + err + ') at ' + row.at;
                        });
                        dmStatus.innerHTML = lines.map((line) => '<div>' + line + '</div>').join('');
                    };

                    const renderChannelStatus = (statusRows) => {
                        if (!channelStatus) return;
                        if (!statusRows.length) {
                            channelStatus.textContent = 'No channel status yet.';
                            return;
                        }
                        const lines = statusRows.map((row) => {
                            if (row.ok) {
                                return row.channelId + ': last post ok at ' + row.at;
                            }
                            const err = row.error?.message || row.error?.error || row.error || 'Unknown error';
                            return row.channelId + ': last post failed (' + err + ') at ' + row.at;
                        });
                        channelStatus.innerHTML = lines.map((line) => '<div>' + line + '</div>').join('');
                    };

                    const refresh = async (preferredGuildId) => {
                        const servers = await fetchServers();
                        const currentSelection = preferredGuildId || serverSelect.value;
                        renderServers(servers);
                        renderServerList(servers);
                        const server = servers.find((s) => s.guildId === currentSelection) || servers[0];
                        if (server) {
                            serverSelect.value = server.guildId;
                        }
                        renderRoles(server);
                        const dmRes = await fetch('/admin/dm-users');
                        if (dmRes.ok) {
                            const recipients = await dmRes.json();
                            renderDmRecipients(recipients);
                        }
                        const statusRes = await fetch('/admin/dm-status');
                        if (statusRes.ok) {
                            const statusRows = await statusRes.json();
                            renderDmStatus(statusRows);
                        }
                        const channelRes = await fetch('/admin/channels');
                        if (channelRes.ok) {
                            const recipients = await channelRes.json();
                            renderChannelRecipients(recipients);
                        }
                        const channelStatusRes = await fetch('/admin/channel-status');
                        if (channelStatusRes.ok) {
                            const statusRows = await channelStatusRes.json();
                            renderChannelStatus(statusRows);
                        }
                    };

                    document.getElementById('loginBtn').addEventListener('click', async () => {
                        clearMsg(loginMsg);
                        const username = document.getElementById('loginUser').value.trim();
                        const password = document.getElementById('loginPass').value.trim();
                        const res = await fetch('/admin/login', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ username, password })
                        });
                        const data = await res.json().catch(() => ({}));
                        if (!res.ok) {
                            setMsg(loginMsg, data.error || 'Login failed.', true);
                            return;
                        }
                        loginCard.style.display = 'none';
                        adminCard.style.display = 'block';
                        if (dmCard) dmCard.style.display = 'block';
                        const channelCard = document.getElementById('channelCard');
                        if (channelCard) channelCard.style.display = 'block';
                        await refresh();
                    });

                    document.getElementById('addServerBtn').addEventListener('click', async () => {
                        clearMsg(serverMsg);
                        const name = document.getElementById('serverName').value.trim();
                        const guildId = document.getElementById('guildId').value.trim();
                        if (!guildId) {
                            setMsg(serverMsg, 'Guild ID is required.', true);
                            return;
                        }
                        const res = await fetch('/admin/servers', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name, guildId })
                        });
                        const data = await res.json().catch(() => ({}));
                        if (!res.ok) {
                            setMsg(serverMsg, data.error || 'Failed to add server.', true);
                            return;
                        }
                        setMsg(serverMsg, 'Server added.', false);
                        document.getElementById('serverName').value = '';
                        document.getElementById('guildId').value = '';
                        await refresh();
                    });

                    roleInput.addEventListener('keydown', async (e) => {
                        if (e.key !== 'Enter') return;
                        e.preventDefault();
                        const roleId = roleInput.value.trim();
                        const guildId = serverSelect.value;
                        if (!roleId || !guildId) return;
                        await fetch('/admin/roles', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ guildId, roleId })
                        });
                        roleInput.value = '';
                        await refresh();
                    });

                    dmInput.addEventListener('keydown', async (e) => {
                        if (e.key !== 'Enter') return;
                        e.preventDefault();
                        const userId = dmInput.value.trim();
                        if (!userId) return;
                        await fetch('/admin/dm-users', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ userId })
                        });
                        dmInput.value = '';
                        await refresh(serverSelect.value);
                    });

                    channelInput.addEventListener('keydown', async (e) => {
                        if (e.key !== 'Enter') return;
                        e.preventDefault();
                        const channelId = channelInput.value.trim();
                        if (!channelId) return;
                        await fetch('/admin/channels', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ channelId })
                        });
                        channelInput.value = '';
                        await refresh(serverSelect.value);
                    });

                    serverSelect.addEventListener('change', async () => {
                        await refresh(serverSelect.value);
                    });

                    document.getElementById('logoutBtn').addEventListener('click', async () => {
                        await fetch('/admin/logout', { method: 'POST' });
                        adminCard.style.display = 'none';
                        if (dmCard) dmCard.style.display = 'none';
                        const channelCard = document.getElementById('channelCard');
                        if (channelCard) channelCard.style.display = 'none';
                        loginCard.style.display = 'block';
                    });

                    if (homeLink) {
                        homeLink.addEventListener('click', async (e) => {
                            e.preventDefault();
                            await fetch('/admin/logout', { method: 'POST' });
                            window.location.href = '/';
                        });
                    }

                    if (${isAuthed ? 'true' : 'false'}) {
                        refresh().catch(() => {});
                    }
                </script>
            </body>
        </html>
    `);
});

app.post('/admin/login', (req, res) => {
    if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
        return res.status(500).json({ error: 'Admin credentials not configured.' });
    }
    const { username, password } = req.body || {};
    if (String(username || '') !== ADMIN_USERNAME || String(password || '') !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    adminSessions.set(token, { createdAt: Date.now() });
    res.setHeader('Set-Cookie', `admin_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict`);
    return res.json({ ok: true });
});

app.post('/admin/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies.admin_session;
    if (token) {
        adminSessions.delete(token);
    }
    res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
    return res.json({ ok: true });
});

app.get('/admin/servers', requireAdmin, (req, res) => {
    return res.json(getTargetServers());
});

app.post('/admin/servers', requireAdmin, (req, res) => {
    targetServers = getTargetServers();
    const { guildId, name } = req.body || {};
    const cleanId = String(guildId || '').trim();
    const cleanName = String(name || '').trim();
    if (!cleanId) {
        return res.status(400).json({ error: 'Guild ID is required.' });
    }
    if (targetServers.find((s) => s.guildId === cleanId)) {
        return res.status(409).json({ error: 'Server already exists.' });
    }
    const next = { guildId: cleanId, name: cleanName, staffRoles: [] };
    targetServers = [...targetServers, next];
    saveTargetServers(targetServers);
    return res.json(next);
});

app.delete('/admin/servers', requireAdmin, (req, res) => {
    targetServers = getTargetServers();
    const { guildId } = req.body || {};
    const cleanId = String(guildId || '').trim();
    if (!cleanId) {
        return res.status(400).json({ error: 'Guild ID is required.' });
    }
    const before = targetServers.length;
    targetServers = targetServers.filter((s) => s.guildId !== cleanId);
    if (targetServers.length === before) {
        return res.status(404).json({ error: 'Server not found.' });
    }
    saveTargetServers(targetServers);
    return res.json({ ok: true });
});

app.post('/admin/roles', requireAdmin, (req, res) => {
    targetServers = getTargetServers();
    const { guildId, roleId } = req.body || {};
    const cleanGuildId = String(guildId || '').trim();
    const cleanRoleId = String(roleId || '').trim();
    if (!cleanGuildId || !cleanRoleId) {
        return res.status(400).json({ error: 'Guild ID and role ID are required.' });
    }
    const server = targetServers.find((s) => s.guildId === cleanGuildId);
    if (!server) {
        return res.status(404).json({ error: 'Server not found.' });
    }
    if (!server.staffRoles.includes(cleanRoleId)) {
        server.staffRoles.push(cleanRoleId);
        saveTargetServers(targetServers);
    }
    return res.json(server);
});

app.delete('/admin/roles', requireAdmin, (req, res) => {
    targetServers = getTargetServers();
    const { guildId, roleId } = req.body || {};
    const cleanGuildId = String(guildId || '').trim();
    const cleanRoleId = String(roleId || '').trim();
    if (!cleanGuildId || !cleanRoleId) {
        return res.status(400).json({ error: 'Guild ID and role ID are required.' });
    }
    const server = targetServers.find((s) => s.guildId === cleanGuildId);
    if (!server) {
        return res.status(404).json({ error: 'Server not found.' });
    }
    server.staffRoles = server.staffRoles.filter((r) => r !== cleanRoleId);
    saveTargetServers(targetServers);
    return res.json(server);
});

app.get('/admin/dm-users', requireAdmin, (req, res) => {
    return res.json(dmRecipients);
});

app.post('/admin/dm-users', requireAdmin, (req, res) => {
    const { userId } = req.body || {};
    const cleanUserId = String(userId || '').trim();
    if (!cleanUserId) {
        return res.status(400).json({ error: 'User ID is required.' });
    }
    if (!dmRecipients.includes(cleanUserId)) {
        dmRecipients = [...dmRecipients, cleanUserId];
        saveDmRecipients(dmRecipients);
    }
    return res.json(dmRecipients);
});

app.delete('/admin/dm-users', requireAdmin, (req, res) => {
    const { userId } = req.body || {};
    const cleanUserId = String(userId || '').trim();
    if (!cleanUserId) {
        return res.status(400).json({ error: 'User ID is required.' });
    }
    dmRecipients = dmRecipients.filter((id) => id !== cleanUserId);
    dmSendStatus.delete(cleanUserId);
    saveDmRecipients(dmRecipients);
    return res.json(dmRecipients);
});

app.get('/admin/dm-status', requireAdmin, (req, res) => {
    const rows = dmRecipients.map((userId) => ({
        userId,
        ...(dmSendStatus.get(userId) || {})
    })).filter((row) => row.ok !== undefined);
    return res.json(rows);
});

app.get('/admin/channels', requireAdmin, (req, res) => {
    return res.json(channelRecipients);
});

app.post('/admin/channels', requireAdmin, (req, res) => {
    const { channelId } = req.body || {};
    const cleanChannelId = String(channelId || '').trim();
    if (!cleanChannelId) {
        return res.status(400).json({ error: 'Channel ID is required.' });
    }
    if (!channelRecipients.includes(cleanChannelId)) {
        channelRecipients = [...channelRecipients, cleanChannelId];
        saveChannelRecipients(channelRecipients);
    }
    return res.json(channelRecipients);
});

app.delete('/admin/channels', requireAdmin, (req, res) => {
    const { channelId } = req.body || {};
    const cleanChannelId = String(channelId || '').trim();
    if (!cleanChannelId) {
        return res.status(400).json({ error: 'Channel ID is required.' });
    }
    channelRecipients = channelRecipients.filter((id) => id !== cleanChannelId);
    channelSendStatus.delete(cleanChannelId);
    saveChannelRecipients(channelRecipients);
    return res.json(channelRecipients);
});

app.get('/admin/channel-status', requireAdmin, (req, res) => {
    const rows = channelRecipients.map((channelId) => ({
        channelId,
        ...(channelSendStatus.get(channelId) || {})
    })).filter((row) => row.ok !== undefined);
    return res.json(rows);
});

// 1. Initial Login Route
app.get('/login', (req, res) => {
    if (!CLIENT_ID || !CLIENT_SECRET) {
        return res.status(500).send('Server misconfigured: missing Discord client credentials.');
    }
    const redirectUri = getRedirectUri(req);
    const oauthUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify%20guilds%20guilds.members.read`;
    res.redirect(oauthUrl);
});

// 2. OAuth2 Callback Route
app.get('/callback', async (req, res) => {
    const { code, error, error_description } = req.query;
    console.log('OAuth callback query:', req.query);
    if (error) {
        return res.status(400).send(`OAuth error: ${error}${error_description ? ` - ${error_description}` : ''}`);
    }
    if (!code) {
        const redirectUri = getRedirectUri(req);
        return res.status(400).send(
            `No code provided. Check that your Discord OAuth2 redirect URI exactly matches: ${redirectUri}`
        );
    }

    try {
        const redirectUri = getRedirectUri(req);
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
            scope: 'identify guilds guilds.members.read',
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const accessToken = tokenResponse.data.access_token;
        const scanId = crypto.randomBytes(16).toString('hex');
        const currentTargets = getTargetServers();
        scanResults.set(scanId, {
            state: 'running',
            total: currentTargets.length,
            checked: 0,
            current: null
        });
        scheduleScanCleanup(scanId);

        const runScan = async () => {
            const rosteredServers = [];
            const failedServers = [];
            let userTag = 'unknown user';
            let userId = 'unknown';

            try {
                const meResponse = await axios.get('https://discord.com/api/users/@me', {
                    headers: { Authorization: `Bearer ${accessToken}` }
                });
                userId = meResponse.data.id;
                userTag = `${meResponse.data.username || 'unknown user'}`;
            } catch (err) {
                console.warn('Failed to fetch user identity:', err.response?.data || err.message);
            }

            let checked = 0;
            for (const target of currentTargets) {
                const currentLabel = target.name || target.guildId;
                scanResults.set(scanId, {
                    state: 'running',
                    total: currentTargets.length,
                    checked,
                    current: currentLabel
                });
                try {
                    const memberResponse = await fetchGuildMemberWithRetry(
                        accessToken,
                        target.guildId,
                        3,
                        (waitMs) => {
                            scanResults.set(scanId, {
                                state: 'paused',
                                total: targetServers.length,
                                checked,
                                current: currentLabel,
                                resumeAt: Date.now() + waitMs
                            });
                        }
                    );
                    const userRoles = Array.isArray(memberResponse.data?.roles) ? memberResponse.data.roles : [];
                    const foundRoles = userRoles.filter((roleId) => target.staffRoles.includes(roleId));
                    if (foundRoles.length > 0) {
                        rosteredServers.push({
                            name: target.name || 'Unknown Server',
                            guildId: target.guildId
                        });
                    }
                } catch (err) {
                    const status = err.response?.status;
                    if (status === 404) {
                        console.log(`User not in guild ${target.guildId}`);
                    } else {
                        console.warn(`Failed to read member for guild ${target.guildId}:`, err.response?.data || err.message);
                        failedServers.push({
                            name: target.name || 'Unknown Server',
                            guildId: target.guildId,
                            status: status || 'unknown'
                        });
                    }
                }
                await sleep(GUILD_SCAN_DELAY_MS);
                checked += 1;
                scanResults.set(scanId, {
                    state: 'running',
                    total: currentTargets.length,
                    checked,
                    current: currentLabel
                });
            }

            const uniqueRostered = [];
            const rosteredById = new Set();
            for (const server of rosteredServers) {
                if (rosteredById.has(server.guildId)) continue;
                rosteredById.add(server.guildId);
                uniqueRostered.push(server);
            }
            const isDoubleRostered = uniqueRostered.length >= 2;

            const hasFailures = failedServers.length > 0;
            const failedList = failedServers.map((v) => `**${v.name}** (${v.guildId})`).join('; ');
            const dmServerList = uniqueRostered.map((v) => `**${v.name}** (${v.guildId})`).join('; ');
            const statusMessage = hasFailures
                ? `⚠️ Verification incomplete for **${userTag}** (${userId}). Could not verify: ${failedList}`
                : (uniqueRostered.length > 0
                    ? (isDoubleRostered
                        ? `⚠️ WARNING: **${userTag}** (${userId}) is rostered in multiple servers: ${dmServerList}`
                        : `✅ Verification complete for ${userTag} (${userId}). Rostered in: ${dmServerList}`)
                    : `✅ Verification complete for ${userTag} (${userId}). Not rostered in any target server.`);

            const resultTitle = hasFailures
                ? 'Verification Incomplete'
                : (isDoubleRostered ? 'Verification Warning' : 'Verification Complete');
            const resultBody = hasFailures
                ? `⚠️ Some servers could not be verified:<br>${failedServers
                      .map(v => `<b>${v.name}</b> (${v.guildId})`)
                      .join('<br>')}`
                : (uniqueRostered.length > 0
                    ? (isDoubleRostered
                        ? `⚠️ Rostered in multiple servers:<br>${uniqueRostered
                              .map(v => `<b>${v.name}</b> (${v.guildId})`)
                              .join('<br>')}`
                        : `✅ Rostered in:<br>${uniqueRostered
                              .map(v => `<b>${v.name}</b> (${v.guildId})`)
                              .join('<br>')}`)
                    : '✅ Not rostered in any target server.');

            scanResults.set(scanId, {
                state: 'done',
                isDoubleRostered,
                resultTitle,
                resultBody,
                statusMessage,
                total: currentTargets.length,
                checked: currentTargets.length,
                current: null
            });

            if (channelRecipients.length > 0) {
                for (const channelId of channelRecipients) {
                    const result = await sendChannelMessageWithRetry(channelId, statusMessage);
                    if (!result.ok) {
                        console.warn(`Failed to post to channel ${channelId}:`, result.error);
                        recordChannelStatus(channelId, false, result.error);
                    } else {
                        recordChannelStatus(channelId, true, null);
                    }
                    await sleep(250);
                }
            } else {
                for (const recipientId of dmRecipients) {
                    const result = await sendStatusDmWithRetry(recipientId, statusMessage);
                    if (!result.ok) {
                        console.warn(`Failed to DM ${recipientId}:`, result.error);
                        recordDmStatus(recipientId, false, result.error);
                    } else {
                        recordDmStatus(recipientId, true, null);
                    }
                    await sleep(250);
                }
            }
        };

        runScan().catch((scanErr) => {
            console.error('Error during verification:', scanErr.response?.data || scanErr.message);
            scanResults.set(scanId, { state: 'error' });
        });

        return res.send(`
            <html>
                <head>
                    <title>Scanning</title>
                    <style>
                        :root {
                            --bg-1: #0f172a;
                            --bg-2: #0b2f4b;
                            --bg-3: #113d5c;
                            --card: rgba(255, 255, 255, 0.08);
                            --card-border: rgba(255, 255, 255, 0.2);
                            --text: #e2e8f0;
                            --muted: #94a3b8;
                            --accent: #38bdf8;
                        }
                        * { box-sizing: border-box; }
                        body {
                            margin: 0;
                            min-height: 100vh;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            background: radial-gradient(1200px circle at 20% 10%, #1e3a8a 0%, transparent 55%),
                                        radial-gradient(1000px circle at 80% 20%, #0ea5e9 0%, transparent 45%),
                                        linear-gradient(135deg, var(--bg-1), var(--bg-2), var(--bg-3));
                            color: var(--text);
                            font-family: "Sora", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
                        }
                        .card {
                            width: min(640px, 92vw);
                            padding: 40px 36px;
                            border-radius: 16px;
                            background: var(--card);
                            border: 1px solid var(--card-border);
                            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
                            text-align: center;
                            backdrop-filter: blur(12px);
                        }
                        h1 { margin: 0 0 10px 0; font-size: 28px; }
                        p { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.6; }
                        .pulse {
                            width: 12px;
                            height: 12px;
                            border-radius: 50%;
                            background: var(--accent);
                            margin: 18px auto 0;
                            box-shadow: 0 0 0 rgba(56, 189, 248, 0.5);
                            animation: pulse 1.6s infinite;
                        }
                        .progress {
                            width: 100%;
                            height: 10px;
                            border-radius: 999px;
                            background: rgba(148, 163, 184, 0.2);
                            overflow: hidden;
                            margin-top: 16px;
                        }
                        .progress-bar {
                            height: 100%;
                            width: 0%;
                            background: linear-gradient(120deg, #38bdf8, #22d3ee);
                            transition: width 250ms ease;
                        }
                        @keyframes pulse {
                            0% { box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.55); }
                            70% { box-shadow: 0 0 0 16px rgba(56, 189, 248, 0); }
                            100% { box-shadow: 0 0 0 0 rgba(56, 189, 248, 0); }
                        }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>Scanning servers</h1>
                        <p>Please keep this tab open until the scan is completed.</p>
                        <p style="margin-top:8px;">Note: This action can take 15+ minutes due to Discord rate limits.</p>
                        <p id="scanProgress" style="margin-top:12px;">Preparing scan…</p>
                        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100">
                            <div class="progress-bar" id="scanBar"></div>
                        </div>
                        <div class="pulse" aria-hidden="true"></div>
                    </div>
                    <script>
                        const scanId = '${scanId}';
                        const progressEl = document.getElementById('scanProgress');
                        const barEl = document.getElementById('scanBar');
                        const poll = async () => {
                            try {
                                const res = await fetch('/scan-status/' + scanId);
                                if (!res.ok) return setTimeout(poll, 1500);
                                const data = await res.json();
                                if (progressEl && (data.state === 'running' || data.state === 'paused')) {
                                    const total = Number(data.total || 0);
                                    const checked = Number(data.checked || 0);
                                    const current = data.current ? 'Checking: ' + data.current : 'Scanning...';
                                    if (data.state === 'paused') {
                                        const resumeAt = Number(data.resumeAt || 0);
                                        const waitSeconds = resumeAt > Date.now()
                                            ? Math.ceil((resumeAt - Date.now()) / 1000)
                                            : 0;
                                        progressEl.textContent = 'Paused due to rate limits. Resuming in ' + waitSeconds + 's.';
                                    } else {
                                        progressEl.textContent = total > 0
                                            ? current + ' (' + checked + '/' + total + ')'
                                            : current;
                                    }
                                    if (barEl && total > 0) {
                                        const pct = Math.min(100, Math.round((checked / total) * 100));
                                        barEl.style.width = pct + '%';
                                        barEl.setAttribute('aria-valuenow', String(pct));
                                    }
                                }
                                if (data.state === 'done' || data.state === 'error') {
                                    if (barEl) {
                                        barEl.style.width = '100%';
                                        barEl.setAttribute('aria-valuenow', '100');
                                    }
                                    setTimeout(() => {
                                        window.location.href = '/scan-result/' + scanId;
                                    }, 500);
                                    return;
                                }
                            } catch (err) {
                                // ignore and keep polling
                            }
                            setTimeout(poll, 1500);
                        };
                        poll();
                    </script>
                </body>
            </html>
        `);
    } catch (error) {
        console.error('Error during verification:', error.response?.data || error.message);
        return res.status(500).send('An error occurred during verification.');
    }
});

app.get('/scan-status/:scanId', (req, res) => {
    const scan = scanResults.get(req.params.scanId);
    if (!scan) {
        return res.status(404).json({ state: 'missing' });
    }
    return res.json({
        state: scan.state,
        total: scan.total || 0,
        checked: scan.checked || 0,
        current: scan.current || null,
        resumeAt: scan.resumeAt || null
    });
});

app.get('/scan-result/:scanId', (req, res) => {
    const scan = scanResults.get(req.params.scanId);
    if (!scan) {
        return res.status(404).send('Scan expired or not found.');
    }
    if (scan.state === 'error') {
        return res.status(500).send('An error occurred during verification.');
    }
    if (scan.state !== 'done') {
        return res.redirect(`/scan-status/${req.params.scanId}`);
    }
    const resultTitle = scan.resultTitle;
    const resultBody = scan.resultBody;
    const isDoubleRostered = Boolean(scan.isDoubleRostered);
    return res.send(`
        <html>
            <head>
                <title>${resultTitle}</title>
                <style>
                    :root {
                        --bg-1: #0f172a;
                        --bg-2: #0b2f4b;
                        --bg-3: #113d5c;
                        --card: rgba(255, 255, 255, 0.08);
                        --card-border: rgba(255, 255, 255, 0.2);
                        --text: #e2e8f0;
                        --muted: #94a3b8;
                        --good: #22c55e;
                        --warn: #f59e0b;
                    }
                    * { box-sizing: border-box; }
                    body {
                        margin: 0;
                        min-height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        background: radial-gradient(1200px circle at 20% 10%, #1e3a8a 0%, transparent 55%),
                                    radial-gradient(1000px circle at 80% 20%, #0ea5e9 0%, transparent 45%),
                                    linear-gradient(135deg, var(--bg-1), var(--bg-2), var(--bg-3));
                        color: var(--text);
                        font-family: "Sora", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
                    }
                    .card {
                        width: min(640px, 92vw);
                        padding: 40px 36px;
                        border-radius: 16px;
                        background: var(--card);
                        border: 1px solid var(--card-border);
                        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
                        text-align: center;
                        backdrop-filter: blur(12px);
                    }
                    h1 {
                        margin: 0 0 10px 0;
                        font-size: 28px;
                    }
                    .status {
                        display: inline-flex;
                        align-items: center;
                        gap: 10px;
                        padding: 8px 14px;
                        border-radius: 999px;
                        font-size: 13px;
                        font-weight: 700;
                        letter-spacing: 0.3px;
                        background: ${isDoubleRostered ? 'rgba(245, 158, 11, 0.2)' : 'rgba(34, 197, 94, 0.2)'};
                        color: ${isDoubleRostered ? 'var(--warn)' : 'var(--good)'};
                        margin-bottom: 18px;
                    }
                    .body {
                        color: var(--muted);
                        font-size: 15px;
                        line-height: 1.6;
                    }
                    .body b { color: var(--text); }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="status">${isDoubleRostered ? 'Warning' : 'Success'}</div>
                    <h1>${resultTitle}</h1>
                    <div class="body">${resultBody}</div>
                </div>
            </body>
        </html>
    `);
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running at http://localhost:${PORT}`));
