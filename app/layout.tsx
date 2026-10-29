import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Messagner',
  description: 'Private messaging built for speed and simplicity'
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
