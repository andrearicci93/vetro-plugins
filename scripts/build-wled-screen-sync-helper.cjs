#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const root = path.join(__dirname, '..');
const project = path.join(root, 'helpers/wled-screen-sync');
const plugin = path.join(root, 'plugins/wled-screen-sync');
const check = process.argv.includes('--check');
const sdk = JSON.parse(fs.readFileSync(path.join(project, 'global.json'), 'utf8')).sdk.version;
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

function verifyPayload(rebuilt, encoded) {
    const rebuiltSha256 = sha256(rebuilt);
    const embeddedSha256 = sha256(Buffer.from(encoded.trim(), 'base64'));
    if (rebuiltSha256 !== embeddedSha256) throw Error('Helper DLL SHA-256 mismatch: rebuilt ' + rebuiltSha256 + ', embedded ' + embeddedSha256);
    return {rebuiltSha256, embeddedSha256};
}

function run(args, extraEnv) {
    const result = cp.spawnSync('dotnet', args, {cwd: project, stdio: 'inherit', env: {...process.env, ...extraEnv}});
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error('dotnet ' + args[0] + ' failed');
}

function main() {
    try {
        const version = cp.spawnSync('dotnet', ['--version'], {cwd: project, encoding: 'utf8'});
        if (version.error || version.status !== 0 || version.stdout.trim() !== sdk) throw Error('Build requires exact .NET SDK ' + sdk);
        run(['build', 'WledScreenSync.csproj', '-c', 'Release', '--nologo', '-p:UseSharedCompilation=false']);
        const out = path.join(project, 'bin/Release/netcoreapp3.1');
        const dll = fs.readFileSync(path.join(out, 'Colour.dll'));
        if (process.platform === 'linux') {
            const guard = cp.spawnSync('dotnet', [path.join(out, 'Colour.dll'), '--check-platform'], {
                cwd: project, encoding: 'utf8', timeout: 5000, env: {...process.env, DOTNET_ROLL_FORWARD: 'Major'}
            });
            if (guard.error || guard.status !== 2 || !/32-bit little-endian/.test(guard.stderr)) {
                throw Error('The helper did not refuse the unsupported 64-bit layout');
            }
        }
        const files = {
            'payload.b64': dll.toString('base64') + '\n',
            'Colour.runtimeconfig.json': fs.readFileSync(path.join(out, 'Colour.runtimeconfig.json'), 'utf8'),
            'Colour.deps.json': fs.readFileSync(path.join(out, 'Colour.deps.json'), 'utf8')
        };
        for (const name of Object.keys(files)) {
            const target = path.join(plugin, name);
            if (check) {
                if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== files[name]) {
                    if (name === 'payload.b64') verifyPayload(dll, fs.readFileSync(target, 'utf8'));
                    throw Error(name + ' differs from rebuilt helper');
                }
            } else fs.writeFileSync(target, files[name]);
        }
        if (check) console.log('WLED helper rebuilt payload matches source; DLL SHA-256 ' + sha256(dll));
        else console.log('Rebuilt WLED helper payload');
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
module.exports = {verifyPayload};
if (require.main === module) main();
