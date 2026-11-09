import root from '../../eslint.config.mjs';

// Entry "@dezon/shared" (src/ ngoài src/server) phải chạy được cả trên trình duyệt:
// cấm import module Node và các global chỉ có trên Node.
export default [
  ...root,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/server/**', 'src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: 'Entry isomorphic không được import module Node. Dùng src/server.',
            },
            {
              group: ['./server', './server/*', '../server/*'],
              message: 'Không import code server vào entry isomorphic.',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'Buffer', 'process', '__dirname', 'require'],
    },
  },
];
