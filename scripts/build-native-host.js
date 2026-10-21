const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') {
    console.error('The CyberDM native host shim is currently built for Windows only.');
    process.exit(1);
}

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'native-host', 'NativeHostShim.cs');
const output = path.join(root, 'native-host', 'native-host-shim.exe');
const compilers = [
    process.env.WINDIR && path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    process.env.WINDIR && path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
].filter(Boolean);
const compiler = compilers.find(candidate => fs.existsSync(candidate));

if (!compiler) {
    console.error('Could not find the .NET Framework C# compiler (csc.exe) required for the native host shim.');
    process.exit(1);
}

const result = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${output}`, source], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log(`Built native messaging shim: ${path.relative(root, output)}`);
