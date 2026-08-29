import type { Config } from 'jest';

const config: Config = {
    displayName: 'player-util',
    preset: '../../../jest.preset.js',
    testEnvironment: 'node',
    coverageDirectory: '../../../coverage/libs/player/util',
};

export default config;
