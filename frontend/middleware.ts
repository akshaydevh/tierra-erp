import { NextResponse, type NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const session = request.cookies.get('tierra_session')
  const login = request.nextUrl.pathname === '/login'
  if (!session && !login) {
    return NextResponse.redirect(new URL('/login', request.url))
  }
  if (session && login) {
    return NextResponse.redirect(new URL('/', request.url))
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api|webhooks).*)'],
}
