import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  allowedDevOrigins: [
    "*.trycloudflare.com",
    "trycloudflare.com",
    "192.168.31.208",
    "localhost:3000",
  ],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Accept-CH",
            value:
              "Sec-CH-UA-Model, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List, Sec-CH-UA-Bitness, Sec-CH-UA-Arch, Sec-CH-UA-Mobile",
          },
          {
            key: "Critical-CH",
            value: "Sec-CH-UA-Model, Sec-CH-UA-Platform-Version",
          },
          {
            key: "Permissions-Policy",
            value: "ch-ua-model=*, ch-ua-platform-version=*",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

