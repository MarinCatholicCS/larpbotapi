import type { Metadata } from "next";
import { Orbitron, Inconsolata, Rationale, Edu_NSW_ACT_Cursive } from "next/font/google";
import "./globals.css";

const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
  display: "swap",
});

const inconsolata = Inconsolata({
  variable: "--font-inconsolata",
  subsets: ["latin"],
  display: "swap",
});

const rationale = Rationale({
  variable: "--font-rationale",
  subsets: ["latin"],
  weight: "400",
  display: "swap",
});

const eduCursive = Edu_NSW_ACT_Cursive({
  variable: "--font-edu-cursive",
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
    <html
      lang="en"
      className={`${orbitron.variable} ${inconsolata.variable} ${rationale.variable} ${eduCursive.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-slate-900 text-white">
        {children}
      </body>
    </html>
  );
}
