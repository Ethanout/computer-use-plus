'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ComponentManager } = require('../src/component-manager');

async function main(argv = process.argv.slice(2)) {
  const action = argv[0] || 'list';
  const dataDir = process.env.COMPUTER_USE_PLUS_DATA_DIR || path.resolve('.data');
  const manager = new ComponentManager({ dataDir });
  let result;
  if (action === 'list') result = manager.list();
  else if (action === 'install') {
    if (!argv[1]) throw new Error('manifest_path_required');
    result = await manager.install(JSON.parse(fs.readFileSync(path.resolve(argv[1]), 'utf8')));
  } else if (action === 'activate') result = await manager.activate(argv[1], argv[2]);
  else if (action === 'uninstall') result = await manager.uninstall(argv[1], argv[2]);
  else throw new Error('component_action_invalid');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { main };
