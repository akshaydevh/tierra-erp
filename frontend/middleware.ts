import { NextResponse, type NextRequest } from 'next/server'

const apiUrl = process.env.API_URL ?? 'http://localhost:3002'

function clearSession(response: NextResponse) {
  response.cookies.set('tierra_session', '', {
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    maxAge: 0,
  })
  return response
}

async function sessionIsLive(token: string): Promise<boolean> {
  try {
    const response = await fetch(`${apiUrl}/api/auth/me`, {
      headers: { cookie: `tierra_session=${token}` },
      cache: 'no-store',
    })
    return response.ok
  } catch {
    return false
  }
}

export async function middleware(request: NextRequest) {
  const token = request.cookies.get('tierra_session')?.value
  const login = request.nextUrl.pathname === '/login'
  const live = token ? await sessionIsLive(token) : false
  if (!live && !login) {
    const response = NextResponse.redirect(new URL('/login', request.url))
    return token ? clearSession(response) : response
  }
  if (live && login) {
    return NextResponse.redirect(new URL('/', request.url))
  }
  if (!live && token) return clearSession(NextResponse.next())
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api|webhooks).*)'],
}
