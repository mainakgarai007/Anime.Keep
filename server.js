import { createApp } from './src/app.js';

const port = process.env.PORT || 3000;
const app = createApp();

app.listen(port, () => {
  console.log(`Anime.Keep running at http://localhost:${port}`);
});
