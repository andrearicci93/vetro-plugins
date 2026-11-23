#!/usr/bin/env node
'use strict';
// Rebuild the embedded managed payload from its readable source; no TV is used.
const fs = require('fs'), path = require('path'), cp = require('child_process'), zlib = require('zlib'), crypto = require('crypto');
const root = path.join(__dirname, '..');
const project = path.join(root, 'helpers/eightbitdo-guide');
const plugin = path.join(root, 'plugins/eightbitdo-guide');
const check = process.argv.includes('--check');
const sdk = JSON.parse(fs.readFileSync(path.join(project, 'global.json'), 'utf8')).sdk.version;
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
function verifyPayload(rebuilt, encoded) {
    const rebuiltSha256 = sha256(rebuilt);
    const embeddedSha256 = sha256(zlib.gunzipSync(Buffer.from(encoded.trim(), 'base64')));
    if (rebuiltSha256 !== embeddedSha256) throw Error('Helper DLL SHA-256 mismatch: rebuilt ' + rebuiltSha256 + ', embedded ' + embeddedSha256);
    return {rebuiltSha256, embeddedSha256};
}
function run(args, extraEnv) {
    const result = cp.spawnSync('dotnet', args, {
        cwd: project, stdio: 'inherit', env: {...process.env, ...extraEnv}
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error('dotnet ' + args[0] + ' failed');
}
function main() { try {
    const version = cp.spawnSync('dotnet', ['--version'], {cwd: project, encoding: 'utf8'});
    if (version.error || version.status !== 0 || version.stdout.trim() !== sdk) throw Error('Build requires exact .NET SDK ' + sdk);
    console.log('Guide helper .NET SDK: ' + sdk);
    run(['build', 'GuideBridge.csproj', '-c', 'Release', '--nologo', '-p:UseSharedCompilation=false']);
    const out = path.join(project, 'bin/Release/netcoreapp3.1');
    // The installed SDK runtime can run the portable filter tests locally.
    run([path.join(out, 'guide-bridge.dll'), '--self-test'], {DOTNET_ROLL_FORWARD: 'Major'});
    if (process.platform === 'linux') run([path.join(out, 'guide-bridge.dll'), '--self-test-files'], {DOTNET_ROLL_FORWARD: 'Major'});
    if (process.arch === 'x64' || process.arch === 'arm64') {
        const guard = cp.spawnSync('dotnet', [path.join(out, 'guide-bridge.dll'), '--check-platform'], {
            cwd: project, encoding: 'utf8', timeout: 5000,
            env: {...process.env, DOTNET_ROLL_FORWARD: 'Major'}
        });
        if (guard.error || guard.status !== 2 || !/32-bit little-endian/.test(guard.stderr)) {
            throw Error('The helper did not refuse the unsupported 64-bit layout before input access');
        }
        console.log('Unsupported runtime is refused before input access');
    }
    const files = {
        'guide-bridge.dll.gz.b64': zlib.gzipSync(fs.readFileSync(path.join(out, 'guide-bridge.dll')), {level: 9}).toString('base64') + '\n',
        'guide-bridge.runtimeconfig.json': fs.readFileSync(path.join(out, 'guide-bridge.runtimeconfig.json'), 'utf8'),
        'guide-bridge.deps.json': fs.readFileSync(path.join(out, 'guide-bridge.deps.json'), 'utf8')
    };
    for (const [name, content] of Object.entries(files)) {
        const target = path.join(plugin, name);
        if (check) {
            let matches = fs.existsSync(target);
            if (matches && name.endsWith('.b64')) {
                const hashes = verifyPayload(fs.readFileSync(path.join(out, 'guide-bridge.dll')), fs.readFileSync(target, 'utf8'));
                console.log('Rebuilt DLL SHA-256: ' + hashes.rebuiltSha256);
                console.log('Embedded DLL SHA-256: ' + hashes.embeddedSha256);
            } else if (matches) matches = fs.readFileSync(target, 'utf8') === content;
            if (!matches) {
                throw Error(name + ' differs from the helper rebuilt from source; run node scripts/build-eightbitdo-guide-helper.cjs');
            }
        } else fs.writeFileSync(target, content);
    }
    if (check) {
        const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'manifest.json'), 'utf8'));
        const bundlePath = path.join(root, 'dist', manifest.id + '-' + manifest.version + '.vplugin');
        const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
        const hashes = verifyPayload(fs.readFileSync(path.join(out, 'guide-bridge.dll')), bundle.files['guide-bridge.dll.gz.b64']);
        console.log('Committed .vplugin DLL SHA-256: ' + hashes.embeddedSha256);
    }
    console.log(check ? 'Guide helper payload matches its source' : 'Rebuilt Guide helper payload');
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} }
module.exports = {verifyPayload};
if (require.main === module) main();
