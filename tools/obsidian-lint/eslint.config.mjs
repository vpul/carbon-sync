import { fileURLToPath } from 'node:url';
import obsidianmd from 'eslint-plugin-obsidianmd';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// The community scanner's fixed ignore list, copied from the directory FAQ
// (https://docs.obsidian.md/community-directory/faq). Names must match exactly
// for the scanner to skip a file, so mirroring it here keeps local results
// identical to what the review bot sees.
const scannerIgnores = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/pkg/**',
  '**/test-vault/**',
  '**/.obsidian/**',
  '**/esbuild.config.mjs',
  '**/version-bump.mjs',
  '**/automation/**',
  '**/*.test.*',
  '**/*.tests.*',
  '**/*.spec.*',
  '**/*.specs.*',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/testUtils/**',
  '**/e2e-tests/**',
  '**/mocks/**',
  '**/__mocks__/**',
  '**/*.cjs',
  '**/*.mjs',
  '**/*.cts',
  '**/*.mts',
  '**/vite/**',
  '**/scripts/**',
  '**/docs/**',
  '**/i18n/**',
  '**/i18next/**',
  '**/locale/**',
  '**/locales/**',
  '**/translations/**',
  '**/l10n/**',
];

export default [
  // Repo-specific extras: the built bundle and agent briefs are not source.
  { ignores: [...scannerIgnores, 'apps/plugin/main.js', 'briefs/**', '**/*.js'] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.ts'] },
        tsconfigRootDir: repoRoot,
      },
    },
    rules: {
      'obsidianmd/ui/sentence-case': [
        'warn',
        {
          // The plugin's own name is a proper noun.
          brands: ['Carbon Sync'],
          // The setup code prefix is a literal the user pastes, not prose.
          ignoreRegex: ['^carbon1:'],
        },
      ],
    },
  },
];
