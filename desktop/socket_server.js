const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const si = require('systeminformation');
const loudness = require('loudness');
const shell = require('shelljs');
const clipboardy = require('clipboardy');
const CryptoJS = require('crypto-js');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = 3001;
const SHARED_SECRET = "ecobridge_secret_key_2026_bridge"; // 32 chars for AES-256
const FIXED_IV = "ecobridge_init_v"; // 16 chars

// Persistent PowerShell process for high-performance input injection
const ps = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-Command', '-'], {
    stdio: ['pipe', 'pipe', 'inherit']
});

// Helper to send command to persistent PowerShell
function sendToPS(command) {
    ps.stdin.write(command + '\n');
}

// Initialize Win32 API in the persistent PowerShell session
sendToPS(`
    $signature = @'
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
'@
    $type = Add-Type -MemberDefinition $signature -Name "Win32Utils" -Namespace "Win32" -PassThru
`);

console.log("Starting EcoBridge Socket Server...");

// Clipboard state
let lastClipboardContent = "";

// Encryption Helper (AES-256-CBC)
function encrypt(text) {
    const key = CryptoJS.enc.Utf8.parse(SHARED_SECRET);
    const iv = CryptoJS.enc.Utf8.parse(FIXED_IV);
    const encrypted = CryptoJS.AES.encrypt(text, key, {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
    });
    return encrypted.toString();
}

function decrypt(ciphertext) {
    const key = CryptoJS.enc.Utf8.parse(SHARED_SECRET);
    const iv = CryptoJS.enc.Utf8.parse(FIXED_IV);
    const decrypted = CryptoJS.AES.decrypt(ciphertext, key, {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
    });
    return decrypted.toString(CryptoJS.enc.Utf8);
}

// System monitoring function with individual error handling to prevent hanging
async function getSystemStats() {
    try {
        // Run calls individually with fallbacks to prevent one sensor from hanging the whole process
        const cpu = await si.currentLoad().catch(e => ({ currentLoad: 0 }));
        const mem = await si.mem().catch(e => ({ total: 1, available: 1 }));
        const graphics = await si.graphics().catch(e => ({ controllers: [] }));
        const cpuTemp = await si.cpuTemperature().catch(e => ({ main: 0 }));
        
        const controllers = graphics.controllers || [];
        const mainGpu = controllers.find(g => g.model && !g.model.includes('Virtual')) || controllers[0] || {};

        const stats = {
            cpu: {
                load: Math.round(cpu.currentLoad || 0),
                temp: Math.round(cpuTemp.main || 0)
            },
            ram: {
                used: Math.round(((mem.total - mem.available) / mem.total) * 100),
                total: Math.round(mem.total / (1024 * 1024 * 1024)),
                active: Math.round((mem.total - mem.available) / (1024 * 1024 * 1024))
            },
            gpu: {
                load: mainGpu.utilizationGpu || mainGpu.memoryUsed || 0,
                temp: mainGpu.temperatureGpu || 0,
                name: mainGpu.model || 'Unknown'
            },
            volume: await loudness.getVolume().catch(() => 50),
            muted: await loudness.getMuted().catch(() => false)
        };

        return stats;
    } catch (error) {
        console.error("Critical error in getSystemStats:", error);
        return null;
    }
}

// Media Control via PowerShell (Encoded for reliability)
function sendMediaKey(key) {
    const codes = {
        playPause: 0xB3,
        next: 0xB0,
        prev: 0xB1,
        stop: 0xB2
    };
    const vkCode = codes[key];
    if (vkCode) {
        console.log(`Media Action: ${key} (0x${vkCode.toString(16)})`);
        
        // PowerShell script to simulate media hardware key press
        const psScript = `
            $signature = '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);'
            $type = Add-Type -MemberDefinition $signature -Name "Win32Utils" -Namespace "Win32" -PassThru
            $type::keybd_event(${vkCode}, 0, 0, 0)
            $type::keybd_event(${vkCode}, 0, 2, 0)
        `;
        
        // Encode to Base64 (UTF-16LE) for PowerShell -EncodedCommand
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        const result = shell.exec(`powershell -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, { silent: true });
        if (result.code !== 0) {
            console.error(`PowerShell Error (${result.code}):`, result.stderr);
        }
    }
}

io.on('connection', (socket) => {
    console.log('Device Connected:', socket.id);

    // Send initial stats on connection
    getSystemStats().then(stats => {
        if (stats) {
            console.log("Sending initial stats to", socket.id);
            socket.emit('stats-update', stats);
        }
    });

    socket.on('register', async (type) => {
        console.log(`Registered as: ${type}`);
        // Send fresh stats immediately upon registration
        const stats = await getSystemStats();
        if (stats) {
            socket.emit('stats-update', stats);
        }
    });

    // Handle Clipboard Sync from Mobile
    socket.on('clipboard-sync', (data) => {
        try {
            const decrypted = decrypt(data.content);
            if (decrypted && decrypted !== lastClipboardContent) {
                console.log("Clipboard received from mobile, updating local...");
                lastClipboardContent = decrypted;
                clipboardy.writeSync(decrypted);
            }
        } catch (e) {
            console.error("Failed to decrypt clipboard from mobile", e);
        }
    });

    // Handle Remote Input from Mobile (Mobile controlling PC)
    socket.on('remote-input', (data) => {
        const { type, params } = data;
        
        switch (type) {
            case 'mouse-move':
                // MOUSEEVENTF_MOVE = 0x0001
                sendToPS(`[Win32.Win32Utils]::mouse_event(0x0001, ${Math.round(params.dx)}, ${Math.round(params.dy)}, 0, 0)`);
                break;
            case 'mouse-click':
                const button = params.button || 'left';
                if (button === 'left') {
                    // LEFTDOWN = 0x0002, LEFTUP = 0x0004
                    sendToPS(`[Win32.Win32Utils]::mouse_event(0x0002, 0, 0, 0, 0)`);
                    sendToPS(`[Win32.Win32Utils]::mouse_event(0x0004, 0, 0, 0, 0)`);
                } else if (button === 'right') {
                    // RIGHTDOWN = 0x0008, RIGHTUP = 0x0010
                    sendToPS(`[Win32.Win32Utils]::mouse_event(0x0008, 0, 0, 0, 0)`);
                    sendToPS(`[Win32.Win32Utils]::mouse_event(0x0010, 0, 0, 0, 0)`);
                }
                break;
            case 'mouse-scroll':
                // WHEEL = 0x0800
                sendToPS(`[Win32.Win32Utils]::mouse_event(0x0800, 0, 0, ${Math.round(params.delta)}, 0)`);
                break;
            case 'keyboard':
                // Simplified keyboard injection via SendKeys if it's a string
                if (params.text) {
                    const escaped = params.text.replace(/([+^%~(){}[\]])/g, '{$1}');
                    sendToPS(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${escaped}")`);
                }
                break;
        }
    });

    // Handle Commands
    socket.on('command', async (data) => {
        console.log(`Command Received: ${data.action}`, data.params);
        
        switch (data.action) {
            case 'media':
                sendMediaKey(data.params.type);
                break;
            case 'volume':
                await loudness.setVolume(data.params.value);
                break;
            case 'mute':
                const isMuted = await loudness.getMuted();
                await loudness.setMuted(!isMuted);
                break;
            case 'system':
                if (data.params.type === 'lock') {
                    shell.exec('rundll32.exe user32.dll,LockWorkStation');
                } else if (data.params.type === 'taskmgr') {
                    shell.exec('start taskmgr');
                }
                break;
        }
        
        // Send updated stats immediately after command
        const stats = await getSystemStats();
        io.emit('stats-update', stats);
    });

    socket.on('disconnect', () => {
        console.log('Disconnected:', socket.id);
    });
});

// Broadcast stats every 5 seconds
setInterval(async () => {
    if (io.engine.clientsCount > 0) {
        const stats = await getSystemStats();
        if (stats) {
            console.log(`Broadcasting stats to ${io.engine.clientsCount} devices`);
            io.emit('stats-update', stats);
        }
    }
}, 5000);

// Monitor local clipboard every 1 second
setInterval(() => {
    if (io.engine.clientsCount > 0) {
        try {
            const currentContent = clipboardy.readSync();
            if (currentContent && currentContent !== lastClipboardContent) {
                console.log("Local clipboard changed, syncing to mobile...");
                lastClipboardContent = currentContent;
                io.emit('clipboard-sync', {
                    content: encrypt(currentContent),
                    timestamp: Date.now()
                });
            }
        } catch (e) {
            // Clipboard might be busy
        }
    }
}, 1000);

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`   - Dashboard Server: http://localhost:${PORT}`);
});
