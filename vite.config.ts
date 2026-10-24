import { defineConfig, loadEnv, type Plugin } from 'vite';

// Mini-app publishing surface from env (see .env.example):
// NEARCASTER_URL = public https origin (tunnel or production); FARCASTER_ASSOC_* = signed accountAssociation.
function miniApp(env: Record<string, string>): Plugin {
  const origin = (env.NEARCASTER_URL ?? '').replace(/\/$/, '');
  // Unsigned until all three values are set: an empty block would read as a bad signature.
  const signed = !!(env.FARCASTER_ASSOC_HEADER && env.FARCASTER_ASSOC_PAYLOAD && env.FARCASTER_ASSOC_SIGNATURE);
  const manifest = () =>
    JSON.stringify(
      {
        ...(signed && {
          accountAssociation: {
            header: env.FARCASTER_ASSOC_HEADER,
            payload: env.FARCASTER_ASSOC_PAYLOAD,
            signature: env.FARCASTER_ASSOC_SIGNATURE,
          },
        }),
        miniapp: {
          version: '1',
          name: 'NearCaster',
          iconUrl: `${origin}/icon.png`,
          homeUrl: `${origin}/`,
          imageUrl: `${origin}/embed.png`,
          buttonTitle: 'See your circle',
          splashImageUrl: `${origin}/splash.png`,
          splashBackgroundColor: '#0e0f14',
          subtitle: 'Your friends of friends',
          description: 'A living map of the people you follow, who they follow, and the communities between them.',
          primaryCategory: 'social',
          tags: ['graph', 'social', 'friends', 'network'],
        },
      },
      null,
      2,
    );
  const embed = () =>
    `<meta name="fc:miniapp" content='${JSON.stringify({
      version: '1',
      imageUrl: `${origin}/embed.png`,
      button: {
        title: 'See your circle',
        action: { type: 'launch_miniapp', name: 'NearCaster', url: `${origin}/`, splashImageUrl: `${origin}/splash.png`, splashBackgroundColor: '#0e0f14' },
      },
    })}' />`;

  return {
    name: 'nearcaster-miniapp',
    transformIndexHtml(html) {
      return origin ? html.replace('<!--miniapp-embed-->', embed()) : html;
    },
    configureServer(server) {
      server.middlewares.use('/.well-known/farcaster.json', (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(manifest());
      });
    },
    generateBundle() {
      if (!origin) return;
      this.emitFile({ type: 'asset', fileName: '.well-known/farcaster.json', source: manifest() });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [miniApp(env)],
    server: {
      port: 5188,
      strictPort: true,
      host: true,
      // Quick tunnels for the Farcaster preview tool.
      allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.app'],
    },
    preview: { port: 5189 },
    build: { target: 'es2022', sourcemap: true },
  };
});
