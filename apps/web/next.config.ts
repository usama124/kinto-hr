import type { NextConfig } from 'next';
const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:4000';
const config: NextConfig = {
  transpilePackages: ['@kinto/contracts'],
  poweredByHeader: false,
  async rewrites() {
    return [
      {
        source: '/api/v1/health/:path*',
        destination: `${apiUrl}/api/v1/health/:path*`,
      },
      {
        source: '/api/v1/auth/:path*',
        destination: `${apiUrl}/api/v1/auth/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};
export default config;
