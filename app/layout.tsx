import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HP-OS",
  description: "HP-OS operational engine for LMNL-built sites",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
