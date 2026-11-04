module.exports = {
  plugins: {
    [require.resolve('./scripts/chat-background/native-surfaces.cjs')]: {},
    tailwindcss: {},
    autoprefixer: {},
  },
};
