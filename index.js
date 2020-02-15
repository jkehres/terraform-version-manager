#!/usr/bin/env node

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsPromises = require('fs').promises;
const unzipper = require('unzipper');
const request = require('superagent');

const EXE_SUFFIX = os.platform() === 'win32' ? '.exe' : ''
const INSTALL_DIR = path.join(os.homedir(), '.tfvm');
const VERSIONS_DIR = path.join(INSTALL_DIR, 'versions');
const CURRENT_LINK = path.join(INSTALL_DIR, `terraform${EXE_SUFFIX}`);

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

function getUrl(version) {
    return `https://releases.hashicorp.com/terraform/${version}/terraform_${version}_${getPlatform()}_${getArch()}.zip`;
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

async function install(version) {
    if (await isInstalled(version)) {
        return;
    }

    await fsPromises.mkdir(VERSIONS_DIR, {recursive: true});

    await new Promise((resolve, reject) => {
        const req = request.get(getUrl(version));
        const unzipStream = unzipper.ParseOne();

        req.on('response', (res) => {
			if (res.status === 200) {
                // creation of stream causes creation of file - wait for 200 response to avoid empty file
                const writeStream = fs.createWriteStream(getPath(version));
                writeStream.on('error', reject);
                writeStream.on('finish', resolve);
                unzipStream.pipe(writeStream);
            } else {
				req.abort();
				reject(new Error(`Download failed with status ${res.status}`));
			}
		})

        req.on('error', reject);
        unzipStream.on('error', reject);
        
        req.pipe(unzipStream);
    });

    // TODO: verify executable integrity - https://www.hashicorp.com/security

    await fsPromises.chmod(getPath(version), '755');
}

async function uninstall(version) {
    const current = await getCurrent();
    if (!current || !await isInstalled(version)) {
        throw new Error(`Version ${version} is not installed`);
    }

    if (version === await getCurrent()) {
        throw new Error('Cannot uninstall current version')
    }

    await fsPromises.unlink(getPath(version));
}

async function setCurrent(version) {
    if (!await isInstalled(version)) {
        throw new Error(`Version ${version} is not installed`);
    }

    try {
        await fsPromises.unlink(CURRENT_LINK);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            throw err;
        }
    }
    
    try {
        await fsPromises.symlink(getPath(version), CURRENT_LINK);
    } catch (err) {
        if (err.code === 'EPERM') {
            throw new Error('Command requires administrator priveleges');
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

require('yargs')
    .command({
        command: 'list', 
        describe: 'show installed versions of terraform',
        handler: async () => {
            try {
                const [current, versions] = await Promise.all([getCurrent(), list()]);
                versions.forEach(version => {
                    if (version === current) {
                        console.log(`  * ${version}`);
                    } else {
                        console.log(`    ${version}`);
                    }
                });
            } catch (err) {
                console.error(err);
            }
        }
    })
    .command({
        command: 'install <version>', 
        describe: 'install the specified version of terraform',
        handler: async (argv) => {
            try {
                console.log(`Downloading terraform version ${argv.version}...`);
                await install(argv.version);
                console.log(`Complete`);
            } catch (err) {
                console.error(err.message);
            }
        }
    })
    .command({
        command: 'uninstall <version>', 
        describe: 'uninstall the specified version of terraform',
        handler: async (argv) => {
            try {
                console.log(`Uninstalling terraform version ${argv.version}...`);
                await uninstall(argv.version);
                console.log(`Complete`);
            } catch (err) {
                console.error(err.message);
            }
        }
    })
    .command({
        command: 'use <version>', 
        describe: 'switch to the specified version of terraform',
        handler: async (argv) => {
            try {
                await setCurrent(argv.version);
                console.log(`Now usng terraform version ${argv.version}`);
            } catch (err) {
                console.error(err.message);
            }
        }
    })
    .demandCommand()
    .help()
    .version(false)
    .strict()
    .argv;
    