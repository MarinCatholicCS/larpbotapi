import type { Metadata } from "next";
import { Orbitron } from "next/font/google";
import "./globals.css";

const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "LARPbot — verify developer claims against real GitHub code",
  description:
    "Stop hiring LARPers. LARPbot reads a candidate's GitHub and tells you what's real.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${orbitron.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-slate-900 text-white">
        {children}
      </body>
    </html>
  );
}
