module.exports = {
  root: true,
  env: {
    es2023: true,
    node: true
  },
  extends: [
    'eslint:recommended',
    'plugin:import/recommended'
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  plugins: [
    'import'
  ],
  rules: {
    semi: ['error', 'always'],
    'import/extensions': ['error', 'always', {
      ignorePackages: true
    }],
    'no-unused-vars': ['warn', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_'
    }]
  },
  settings: {
    'import/resolver': {
      node: {
        extensions: ['.js', '.mjs']
      }
    }
  },
  overrides: [
    {
      files: [
        'tests/**/*.js',
        'tests/**/*.mjs',
        '**/*.test.js',
        '**/*.test.mjs'
      ],
      env: {
        jest: true
      }
    }
  ]
};
