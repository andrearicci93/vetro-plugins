#!/usr/bin/env node
'use strict';
// Rebuild the embedded managed payload from its readable source; no TV is used.
const fs = require('fs'), path = require('path'), cp = require('child_process'), zlib = require('zlib');
const root = path.join(__dirname, '..');
const project = path.join(root, 'helpers/eightbitdo-guide');
const plugin = path.join(root, 'plugins/eightbitdo-guide');
const check = process.argv.includes('--check');
function run(args, extraEnv) {
    const result = cp.spawnSync('dotnet', args, {
        cwd: project, stdio: 'inherit', env: {...process.env, ...extraEnv}
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error('dotnet ' + args[0] + ' failed');
}
try {
    run(['build', 'GuideBridge.csproj', '-c', 'Release', '--nologo']);
    const out = path.join(project, 'bin/Release/netcoreapp3.1');
    // The installed SDK runtime can run the portable filter tests locally.
    run([path.join(out, 'guide-bridge.dll'), '--self-test'], {DOTNET_ROLL_FORWARD: 'Major'});
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
            const matches = fs.existsSync(target) && (name.endsWith('.b64')
                ? zlib.gunzipSync(Buffer.from(fs.readFileSync(target, 'utf8').trim(), 'base64')).equals(fs.readFileSync(path.join(out, 'guide-bridge.dll')))
                : fs.readFileSync(target, 'utf8') === content);
            if (!matches) {
                throw Error(name + ' differs from the helper rebuilt from source; run node scripts/build-eightbitdo-guide-helper.cjs');
            }
        } else fs.writeFileSync(target, content);
    }
    console.log(check ? 'Guide helper payload matches its source' : 'Rebuilt Guide helper payload');
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
