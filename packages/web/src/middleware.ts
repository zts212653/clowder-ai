import { NextResponse } from 'next/server';

export function middleware() {
  return NextResponse.next({
    headers: {
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "frame-ancestors 'self'; script-src 'self' 'unsafe-inline'; object-src 'none'",
    },
  });
}

export const config = { matcher: '/frames/starry' };
