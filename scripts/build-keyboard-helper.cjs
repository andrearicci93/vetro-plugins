#!/usr/bin/env node
'use strict';
// Rebuild the embedded managed capture helper from its readable C# source; no TV is used.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const zlib = require('zlib');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const project = path.join(root, 'helpers/keyboard');
const plugin = path.join(root, 'plugins/keyboard');
const check = process.argv.includes('--check');
const sdk = JSON.parse(fs.readFileSync(path.join(project, 'global.json'), 'utf8')).sdk.version;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const normalizeLf = (text) => text.replace(/\r\n/g, '\n');

function verifyPayload(rebuilt, encoded) {
    const rebuiltSha256 = sha256(rebuilt);
    const embeddedSha256 = sha256(zlib.gunzipSync(Buffer.from(encoded.trim(), 'base64')));
    if (rebuiltSha256 !== embeddedSha256) {
        throw Error('Helper DLL SHA-256 mismatch: rebuilt ' + rebuiltSha256 + ', embedded ' + embeddedSha256);
    }
    return { rebuiltSha256, embeddedSha256 };
}

function run(args, extraEnv) {
    const result = cp.spawnSync('dotnet', args, {
        cwd: project,
        stdio: 'inherit',
        env: { ...process.env, ...extraEnv }
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error('dotnet ' + args[0] + ' failed with status ' + result.status);
}

function main() {
    try {
        const version = cp.spawnSync('dotnet', ['--version'], { cwd: project, encoding: 'utf8' });
        if (version.error || version.status !== 0 || version.stdout.trim() !== sdk) {
            throw Error('Build requires exact .NET SDK ' + sdk + ' (found: ' + (version.stdout || '').trim() + ')');
        }
        console.log('Keyboard helper .NET SDK: ' + sdk);
        run(['build', 'HardwareStreamer.csproj', '-c', 'Release', '--nologo', '-p:UseSharedCompilation=false', '-p:MSBuildEnableWorkloadResolver=false']);

        const out = path.join(project, 'bin/Release/netcoreapp3.1');
        const dllPath = path.join(out, 'hardware-streamer.dll');
        run([dllPath, '--self-test'], { DOTNET_ROLL_FORWARD: 'Major' });

        const platformCheck = cp.spawnSync('dotnet', [dllPath, '--check-platform'], {
            cwd: project,
            encoding: 'utf8',
            timeout: 5000,
            env: { ...process.env, DOTNET_ROLL_FORWARD: 'Major' }
        });
        if (platformCheck.error || platformCheck.status !== 0) {
            throw Error('--check-platform failed: ' + (platformCheck.stderr || 'unknown error'));
        }
        const platformInfo = JSON.parse(platformCheck.stdout.trim());
        if (!platformInfo.arch || !platformInfo.ptrSize) {
            throw Error('--check-platform returned unexpected JSON: ' + platformCheck.stdout);
        }
        console.log('Platform check OK:', platformCheck.stdout.trim());

        const dllBytes = fs.readFileSync(dllPath);
        const files = {
            'hardware-streamer.dll.gz.b64': zlib.gzipSync(dllBytes, { level: 9 }).toString('base64') + '\n',
            'hardware-streamer.runtimeconfig.json': normalizeLf(fs.readFileSync(path.join(out, 'hardware-streamer.runtimeconfig.json'), 'utf8')),
            'hardware-streamer.deps.json': normalizeLf(fs.readFileSync(path.join(out, 'hardware-streamer.deps.json'), 'utf8'))
        };

        for (const [name, content] of Object.entries(files)) {
            const target = path.join(plugin, name);
            if (check) {
                let matches = fs.existsSync(target);
                if (matches && name.endsWith('.b64')) {
                    const hashes = verifyPayload(dllBytes, fs.readFileSync(target, 'utf8'));
                    console.log('Rebuilt DLL SHA-256: ' + hashes.rebuiltSha256);
                    console.log('Embedded DLL SHA-256: ' + hashes.embeddedSha256);
                } else if (matches) {
                    matches = normalizeLf(fs.readFileSync(target, 'utf8')) === content;
                }
                if (!matches) {
                    throw Error(name + ' differs from helper rebuilt from source; run node scripts/build-keyboard-helper.cjs');
                }
            } else {
                fs.writeFileSync(target, content, 'utf8');
            }
        }

        if (check) {
            const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'manifest.json'), 'utf8'));
            const bundlePath = path.join(root, 'dist', manifest.id + '-' + manifest.version + '.vplugin');
            const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
            const hashes = verifyPayload(dllBytes, bundle.files['hardware-streamer.dll.gz.b64']);
            console.log('Committed .vplugin DLL SHA-256: ' + hashes.embeddedSha256);
        }
        console.log(check ? 'Keyboard helper payload matches its source' : 'Rebuilt Keyboard helper payload');
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { verifyPayload };
if (require.main === module) main();
