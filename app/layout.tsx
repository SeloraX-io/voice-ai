import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Voice Agent — Real-time call centre console",
  description:
    "Streaming voice conversations with Gemini Live: continuous microphone capture, sub-second time-to-first-audio and natural interruption.",
};

/** Applied before paint so the chosen theme never flashes. */
const THEME_BOOTSTRAP = `
try {
  var stored = localStorage.getItem("voice-agent-theme");
  document.documentElement.dataset.theme = stored === "light" ? "light" : "dark";
} catch (_) {
  document.documentElement.dataset.theme = "dark";
}
`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
