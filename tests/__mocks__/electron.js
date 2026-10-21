const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const MOCK_USER_DATA = path.join(os.tmpdir(), 'cyberdm-test-' + uuidv4());

module.exports = {
    app: {
        getPath(name) {
            switch (name) {
                case 'userData': return MOCK_USER_DATA;
                case 'downloads': return path.join(os.homedir(), 'Downloads');
                case 'temp': return os.tmpdir();
                default: return path.join(MOCK_USER_DATA, name);
            }
        },
        getName() { return 'CyberDM Test'; },
        getVersion() { return '0.5.5-test'; },
    },
};