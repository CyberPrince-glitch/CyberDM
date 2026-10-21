const path = require('path');

module.exports = {
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    moduleNameMapper: {
        '^electron$': '<rootDir>/tests/__mocks__/electron.js',
    },
    moduleDirectories: ['node_modules', '<rootDir>/src'],
    verbose: true,
};