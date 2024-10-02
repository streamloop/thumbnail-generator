// eslint.config.mjs
import antfu from '@antfu/eslint-config'

// todo reconfigure once this is fixed in idea https://youtrack.jetbrains.com/issue/WEB-61117/ESLint-flat-config-doesnt-work-with-non-default-custom-path-to-the-config-file
export default antfu(
  {
    typescript: true,
    javascript: true,
    react: false,

    jsonc: false,

    rules: {
      'style/arrow-parens': 'off',
      'no-console': 'off',
      // This is breaking decorator metadata
      'ts/consistent-type-imports': 'off',
      'eslint-comments/no-unlimited-disable': 'off',
    },
  },
)
