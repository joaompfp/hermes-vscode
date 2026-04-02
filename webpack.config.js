/* eslint-disable @typescript-eslint/no-var-requires */
const path = require('path');

/** @type {import('webpack').Configuration[]} */
module.exports = [
  // Extension host bundle (Node.js)
  {
    name: 'extension',
    target: 'node',
    entry: './src/extension.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'extension.js',
      libraryTarget: 'commonjs2',
    },
    externals: { vscode: 'commonjs vscode' },
    module: {
      rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
    },
    resolve: { extensions: ['.ts', '.js'] },
  },
  // Webview bundle (browser) — uses its own tsconfig with DOM lib
  {
    name: 'webview',
    target: 'web',
    entry: './src/webview/main.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'webview.js',
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: {
            loader: 'ts-loader',
            options: { configFile: path.resolve(__dirname, 'src/webview/tsconfig.json') },
          },
          exclude: /node_modules/,
        },
      ],
    },
    resolve: { extensions: ['.ts', '.js'] },
  },
];
