import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jbmono",
  subsets: ["latin"],
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  themeColor: "#F6F7F9",
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "PACC — colour optical barcode",
  description:
    "PACC Prototype 23 (PACC): generate, decode and test pilot-equalised, LDPC-coded colour optical symbols with signatures (Ed25519, ML-DSA-44), encryption (passphrase, HPKE incl. post-quantum X-Wing), animated streams, layered near/far symbols and a QR-compatible mode.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} antialiased`}
    >
      <body className="min-h-screen flex flex-col">{children}</body>
    </html>
  );
}
