#!/usr/bin/env node

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsPromises = require('fs').promises;
const unzipper = require('unzipper');
const request = require('superagent');
const openpgp = require('openpgp');

const publicKey = require('./hashiCorpKey');
const sha256Stream = require('./sha256Stream');

const EXE_SUFFIX = os.platform() === 'win32' ? '.exe' : ''
const INSTALL_DIR = path.join(os.homedir(), '.tfvm');
const VERSIONS_DIR = path.join(INSTALL_DIR, 'versions');
const CURRENT_LINK = path.join(INSTALL_DIR, `terraform${EXE_SUFFIX}`);

// TODO: fsPromise alternative
// TODO: README
// TODO: linter
// TODO: tests

function getArch() {
    const arch = os.arch();
    switch (arch) {
        case 'ia32':
            return '386';
        case 'x64':
            return 'amd64';
        default:
            throw new Error(`Unsupported architecture: ${os.arch()}`);
    }
}

function getPlatform() {
    switch (os.platform()) {
        case 'win32':
            return 'windows';
        case 'darwin':
            return 'darwin';
        case 'linux':
            return 'linux';
        default:
            throw new Error(`Unsupported platform: ${os.platform()}`);
    }
}

function getZipName(version) {
    return `terraform_${version}_${getPlatform()}_${getArch()}.zip`;
}

function getExeUrl(version) {
    return `https://releases.hashicorp.com/terraform/${version}/${getZipName(version)}`;
}

function getSumsUrl(version) {
    return `https://releases.hashicorp.com/terraform/${version}/terraform_${version}_SHA256SUMS`;
}

function getSigUrl(version) {
    return `https://releases.hashicorp.com/terraform/${version}/terraform_${version}_SHA256SUMS.sig`;
}

function getPath(version) {
    return path.join(VERSIONS_DIR, `terraform_${version}${EXE_SUFFIX}`);
}

function getVersion(file) {
    const re = new RegExp(`terraform_(.+)${EXE_SUFFIX}`);
    return re.exec(path.basename(file))[1];
}

async function isInstalled(version) {
    try {
        await fsPromises.stat(getPath(version));
        return true;
    } catch (err) {
        if (err.code === 'ENOENT') {
            return false
        } else {
            throw err;
        }
    }
}

async function fetchSum(version) {
    const [sumsRes, sigRes] = await Promise.all([
        request.get(getSumsUrl(version)),
        request.get(getSigUrl(version)).buffer(true)
    ]);

    const result = await openpgp.verify({
        // don't use openpgp.cleartext as is modifies line endings and trims whitespace 
        // of input text, which breaks signature verification
        message: openpgp.message.fromBinary(openpgp.util.encode_utf8(sumsRes.text)),
        signature: await openpgp.signature.read(sigRes.body),
        publicKeys: (await openpgp.key.readArmored(publicKey)).keys
    });
    const verified = await result.signatures[0].verified;
    if (!verified) {
        throw new Error('Signature verification failed')
    }

    const sumsMap = new Map();
    sumsRes.text.split('\n').forEach(row => {
        const [hash, name] = row.split('  ');
        sumsMap.set(name, hash);
    });

    return sumsMap.get(getZipName(version));
}

async function install(version) {
    await fsPromises.mkdir(VERSIONS_DIR, {recursive: true});

    const outputPath = getPath(version);
    const actualSum = await new Promise((resolve, reject) => {
        const req = request.get(getExeUrl(version));
        const unzipStream = unzipper.ParseOne();
        const hashStream = new sha256Stream();

        req.on('response', (res) => {
			if (res.status === 200) {
                // creation of stream causes creation of file - wait for 200 response to avoid empty file
                const writeStream = fs.createWriteStream(outputPath);
                writeStream.on('error', reject);
                writeStream.on('finish', () => resolve(hashStream.digest('hex')));
                unzipStream.pipe(writeStream);
            } else {
				req.abort();
				reject(new Error(`Download failed with status ${res.status}`));
			}
		})

        req.on('error', reject);
        unzipStream.on('error', reject);
        
        req.pipe(hashStream).pipe(unzipStream);
    });

    try {
        const expectedSum = await fetchSum(version);
        if (actualSum !== expectedSum) {
            throw new Error('Hash verification failed');
        }

        await fsPromises.chmod(outputPath, '755');
    } catch (err) {
        await fsPromises.unlink(outputPath);
        throw err;
    }
}

async function uninstall(version) {
    if (await getCurrent() === version) {
        await setCurrent(null);
    }

    await fsPromises.unlink(getPath(version));
}

async function setCurrent(version) {
    try {
        await fsPromises.unlink(CURRENT_LINK);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            throw err;
        }
    }
    
    try {
        if (version !== null) {
            await fsPromises.symlink(getPath(version), CURRENT_LINK);
        }
    } catch (err) {
        if (err.code === 'EPERM') {
            throw new Error('Insufficient permissions to set new version - retry as an administrator');
        }
    }
}

async function getCurrent() {
    try {
        const file = await fsPromises.readlink(CURRENT_LINK);
        return getVersion(file);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return null;
        } else {
            throw err;
        }
    }
}

async function list() {
    try {
        const files = await fsPromises.readdir(VERSIONS_DIR);
        return files.map(getVersion).sort();
    } catch (err) {
        if (err.code === 'ENOENT') {
            return [];
        } else {
            throw err;
        }
    }
}

async function listCommand() {
    const [current, versions] = await Promise.all([getCurrent(), list()]);
    if (versions.length === 0) {
        console.log('No versions installed');
    } else {
        versions.forEach(version => {
            if (version === current) {
                console.log(`  * ${version}`);
            } else {
                console.log(`    ${version}`);
            }
        });
    }
}

async function useCommand(argv) {
    if (!await isInstalled(argv.version)) {
        throw new Error(`Version ${argv.version} is not installed`);
    }

    await setCurrent(argv.version);
    console.log(`Now using version ${argv.version}`);
}

async function installCommand(argv) {
    if (await isInstalled(argv.version)) {
        console.log(`Version ${argv.version} already installed`);
    } else {
        console.log(`Downloading version ${argv.version}...`);
        await install(argv.version);
        console.log(`Complete`);
        if (await getCurrent() === null) {
            await useCommand();
        }
    }
}

async function uninstallCommand(argv) {
    if (!await isInstalled(argv.version)) {
        throw new Error(`Version ${argv.version} is not installed`);
    }

    console.log(`Uninstalling version ${argv.version}...`);
    await uninstall(argv.version);
    console.log(`Complete`);

    if (await getCurrent() === null) {
        console.log('WARNING: No version is set')
    }
}

function commandRunner(commandFunc) {
    return async (argv) => {
        try {
            await commandFunc(argv);
        } catch (err) {
            console.error(`ERROR: ${err.message}`);
            process.exitCode = 1;
        }
    };
}

require('yargs')
    .command({
        command: 'list', 
        describe: 'Show installed versions of Terraform',
        handler: commandRunner(listCommand)
    })
    .command({
        command: 'use <version>', 
        describe: 'Switch to the specified version of Terraform',
        handler: commandRunner(useCommand)
    })
    .command({
        command: 'install <version>', 
        describe: 'Install the specified version of Terraform',
        handler: commandRunner(installCommand)
    })
    .command({
        command: 'uninstall <version>', 
        describe: 'Uninstall the specified version of Terraform',
        handler: commandRunner(uninstallCommand)
    })
    .demandCommand()
    .help()
    .version(false)
    .strict()
    .argv;
    