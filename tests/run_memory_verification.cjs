
const { _electron: electron } = require('playwright');
const path = require('path');

const RESULT_PREFIX = 'AI_WORKER_MEMORY_VERIFICATION_RESULT='

(async () => {
    console.log('🚀 Starting Memory Architecture Verification Driver...');

    // Find the installed electron binary
    const macPath = path.join(__dirname, '../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
    const linuxPath = path.join(__dirname, '../node_modules/electron/dist/electron');
    let execPath = macPath;
    if (!require('fs').existsSync(macPath)) execPath = linuxPath;

    let electronApp;
    let stdout = '';
    try {
        electronApp = await electron.launch({
            executablePath: execPath,
            args: [path.join(__dirname, '../out/main/index.js'), '--no-sandbox', '--ai-worker-run-memory-verification'],
            env: { ...process.env, NODE_ENV: 'production' }
        });

        const child = electronApp.process();
        child.stdout.on('data', data => {
            const text = data.toString()
            stdout += text
            console.log(`[Main] ${text.trimEnd()}`)
        });
        electronApp.process().stderr.on('data', data => console.error(`[Main Error] ${data}`));

        const { code } = await new Promise((resolve, reject) => {
            child.once('error', reject)
            child.once('exit', code => resolve({ code }))
        });
        const marker = stdout.split(/\r?\n/).find(line => line.startsWith(RESULT_PREFIX))
        if (!marker) throw new Error(`Electron exited with code ${code} without memory verification results.`)
        const result = JSON.parse(marker.slice(RESULT_PREFIX.length))

        console.log('\n--- Test Results ---');
        result.results.forEach(line => console.log(line));
        if (result.passed && code === 0) {
            console.log('\n🎉 ALL MEMORY TESTS PASSED');
            process.exitCode = 0;
        } else {
            console.error('\n❌ SOME TESTS FAILED');
            process.exitCode = 1;
        }

    } catch (error) {
        console.error('❌ Driver Error:', error);
        process.exitCode = 1;
    } finally {
        if (electronApp) {
            try { await electronApp.close() } catch { /* Electron may have already exited. */ }
        }
    }
})();
