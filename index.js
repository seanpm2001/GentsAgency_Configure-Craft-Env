#!/usr/bin/env node

const fs = require('fs-extra');
const cp = require('child_process');
const path = require('path');
const yaml = require('js-yaml');
const minimist = require('minimist');

const homedir = require('os').homedir();

const directory = path.basename(process.cwd());

const argv = minimist(process.argv.slice(2));

const project = (() => {
	try {
		// eslint-disable-next-line
		const pkg = require(`${process.cwd()}/package.json`);

		if (pkg && pkg.name) {
			return pkg.name.split('/').pop();
		}
	} catch (error) {
		return directory;
	}

	return directory;
})();

const run = (cmd, options = { cwd: process.cwd() }) => new Promise((resolve, reject) => {
	cp.exec(cmd, options, (err) => {
		if (err) {
			return reject(err);
		}

		return resolve();
	});
});

const securityKey = argv['security-key'];
const localDomain = typeof argv.domain === 'string' ? argv.domain : `${project}.local`;
const homesteadPath = typeof argv['homestead-path'] === 'string' ? argv['homestead-path'] : `${homedir}/homestead/Homestead`;
const sslPath = typeof argv['ssl-path'] === 'string' ? argv['ssl-path'] : `${homedir}/.homesteadssl`;

const databasePrefix = typeof argv['db-prefix'] === 'string' ? argv['db-prefix'] : undefined;

const remoteDatabase = (() => {
	if (typeof argv['remote-db-user'] !== 'string') {
		return undefined;
	}

	if (typeof argv['remote-db-password'] !== 'string') {
		return undefined;
	}

	if (typeof argv['remote-db-host'] !== 'string') {
		return undefined;
	}

	return {
		user: argv['remote-db-user'],
		password: argv['remote-db-password'],
		host: argv['remote-db-host'],
		name: typeof argv['remote-db-name'] === 'string' ? argv['remote-db-name'] : project,
		port: typeof argv['remote-db-port'] === 'number' ? argv['remote-db-port'] : 3306,
		schema: typeof argv['remote-db-schema'] === 'string' ? argv['remote-db-schema'] : 'public',
	};
})();

const readFile = (file) => new Promise((resolve, reject) => {
	fs.readFile(file, 'utf8', (readErr, data) => {
		if (readErr) {
			return reject(readErr);
		}

		return resolve(data);
	});
});

const replaceInFile = (file, replacements = {}) => new Promise((resolve, reject) => {
	fs.readFile(file, 'utf8', (readErr, data) => {
		if (readErr) {
			return reject(readErr);
		}

		const replaced = Object.entries(replacements).reduce((string, [pattern, replacement]) => string.replace(pattern, replacement), data);

		return fs.writeFile(file, replaced, 'utf8', (writeErr) => {
			if (writeErr) {
				return reject(writeErr);
			}

			return resolve();
		});
	});
});

(async function configureCraftEnv() {
	console.clear();
	console.log('');
	console.log('🐣 Configuring your development environment');
	console.log('');
	console.log('    Project name:');
	console.log(`      ${project}`);
	console.log('');
	console.log('    Local domain:');
	console.log(`      ${localDomain}`);
	console.log('');
	console.log('    Homestead path:');
	console.log(`      ${homesteadPath}`);
	console.log('');

	console.log('🚜 Configuring Homestead');
	console.log('');
	const config = await readFile(`${homesteadPath}/Homestead.yaml`);
	const parsed = yaml.safeLoad(config);

	if (!parsed.folders) {
		parsed.folders = [];
	}

	if (!parsed.folders.find((folder) => folder.map === process.cwd())) {
		parsed.folders.push({
			map: process.cwd(),
			to: `/home/vagrant/homestead/${project}`,
			type: 'nfs',
		});
	}

	if (!parsed.folders.find((folder) => folder.map === sslPath)) {
		parsed.folders.push({
			map: sslPath,
			to: '/home/vagrant/.homesteadssl',
			type: 'nfs',
		});
	}

	if (!parsed.sites) {
		parsed.sites = [];
	}

	if (!parsed.sites.find((site) => site.map === localDomain)) {
		parsed.sites.push({
			map: localDomain,
			to: `/home/vagrant/homestead/${project}/www`,
		});
	}

	if (!parsed.databases) {
		parsed.databases = [];
	}

	if (!parsed.databases.find((database) => database === project)) {
		parsed.databases.push(project);
	}

	await fs.outputFile(`${homesteadPath}/Homestead.yaml`, yaml.safeDump(parsed));

	console.log('📒 Updating /etc/hosts file (this might ask for your password)');
	console.log('');

	try {
		await fs.appendFile('/etc/hosts', `${parsed.ip} ${localDomain}\r\n`);
	} catch (error) {
		await run(`echo "${parsed.ip} ${localDomain}" | sudo tee -a /etc/hosts`);
	}

	console.log('🏁 Provisioning Homestead');
	console.log('');
	await run('vagrant reload --provision', { cwd: homesteadPath });
	await run(`vagrant ssh -- -t "echo '127.0.0.1 ${localDomain}' | sudo tee -a /etc/hosts"`, { cwd: homesteadPath });

	console.log('🔐 Copying SSL certificate (this might ask for your password)');
	console.log('');
	await fs.ensureDir(sslPath);
	await run(`vagrant ssh -- -t "mkdir -p /home/vagrant/.homesteadssl && cp /etc/nginx/ssl/${localDomain}.crt /home/vagrant/.homesteadssl/${localDomain}.crt"`, { cwd: homesteadPath });
	await run(`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${sslPath}/${localDomain}.crt"`);

	console.log('🍱 Creating .env files');
	console.log('');
	const dotenv = path.resolve(process.cwd(), './craft/.env');

	try {
		await fs.copy(`${dotenv}.example`, dotenv);
		await replaceInFile(dotenv, {
			'SECURITY_KEY=""': `SECURITY_KEY="${securityKey}"`,
			'DB_SERVER="localhost"': `DB_SERVER="${parsed.ip}"`,
			'DB_USER="root"': 'DB_USER="homestead"',
			'DB_PASSWORD=""': 'DB_PASSWORD="secret"',
			'DB_DATABASE=""': `DB_DATABASE="${project}"`,
			'DB_TABLE_PREFIX=""': `DB_PREFIX="${databasePrefix || ''}"`,
		});
	} catch (error) {
		console.log(`	Could not create ./craft/.env at ${dotenv}`);
		console.log('');
	}

	const dotenvsh = path.resolve(process.cwd(), './scripts/.env.sh');

	try {
		await fs.copy(path.resolve(process.cwd(), './scripts/craft3-example.env.sh'), dotenvsh);

		const replacements = {
			'GLOBAL_CRAFT_PATH="./"': 'GLOBAL_CRAFT_PATH="./craft/"',
			'LOCAL_ROOT_PATH="REPLACE_ME"': `LOCAL_ROOT_PATH="${process.cwd()}/"`,
			// eslint-disable-next-line
			'LOCAL_ASSETS_PATH=${LOCAL_ROOT_PATH}"REPLACE_ME"': 'LOCAL_ASSETS_PATH=\${LOCAL_ROOT_PATH}"files/"',
			'LOCAL_DB_NAME="REPLACE_ME"': `LOCAL_DB_NAME="${project}"`,
			'LOCAL_DB_PASSWORD="REPLACE_ME"': 'LOCAL_DB_PASSWORD="secret"',
			'LOCAL_DB_USER="REPLACE_ME"': 'LOCAL_DB_USER="homestead"',
			'LOCAL_DB_HOST="localhost"': `LOCAL_DB_HOST="${parsed.ip}"`,
		};

		if (remoteDatabase) {
			Object.assign(replacements, {
				'REMOTE_DB_NAME="REPLACE_ME"': `REMOTE_DB_NAME="${remoteDatabase.name}"`,
				'REMOTE_DB_PASSWORD="REPLACE_ME"': `REMOTE_DB_PASSWORD="${remoteDatabase.password}"`,
				'REMOTE_DB_USER="REPLACE_ME"': `REMOTE_DB_USER="${remoteDatabase.user}"`,
				'REMOTE_DB_HOST="localhost"': `REMOTE_DB_HOST="${remoteDatabase.host}"`,
				'REMOTE_DB_PORT="3306"': `REMOTE_DB_PORT="${remoteDatabase.port}"`,
				'REMOTE_DB_SCHEMA="public"': `REMOTE_DB_SCHEMA="${remoteDatabase.schema}"`,
			});
		}

		if (databasePrefix) {
			Object.assign(replacements, {
				'GLOBAL_DB_TABLE_PREFIX=""': `GLOBAL_DB_TABLE_PREFIX="${databasePrefix}_"`,
			});
		}

		await replaceInFile(dotenvsh, replacements);
	} catch (error) {
		console.log(`	Could not create ./scripts/.env.sh at ${dotenvsh}`);
		console.log('');
	}

	if (!securityKey) {
		console.log('🔑 Generating security key');
		console.log('');
		await run('./craft/craft setup/security-key', { cwd: process.cwd() });
	}

	console.log('🌎 Get ready to rumble!');
	console.log('');
	console.log('    If this is a new site, you can finish your installation:');
	console.log(`      http://${localDomain}/index.php?p=admin`);
	console.log('');
	console.log('    If this is an existing site, import the remote database:');
	console.log('      $ ./scripts/pull_db.sh');
	console.log('');
}());
