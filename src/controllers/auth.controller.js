const httpStatus = require('http-status-codes');
const authService = require('../services/auth.service');
const env = require('../config/env');
const {
  getClientBaseUrl,
  resolveClientUrlFromRequest,
  isAllowedClientOrigin,
  normalizeUrl,
} = require('../utils/clientUrl.util');

const REFRESH_COOKIE_NAME = 'refreshToken';
const GOOGLE_STATE_COOKIE = 'google_oauth_state';
const GOOGLE_CLIENT_URL_COOKIE = 'google_oauth_client_url';
const GOOGLE_INVITE_TOKEN_COOKIE = 'google_oauth_invite_token';

// Cross-site (Vercel frontend → Render API) needs SameSite=None + Secure in production
const isProd = env.NODE_ENV === 'production';
const oauthCookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? 'none' : 'lax',
  path: '/api/v1/auth',
};
const refreshCookieOptions = {
  ...oauthCookieOptions,
  // Session cookie: cleared when the browser is closed — no multi-day silent login
};

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions);
}

function clearRefreshCookie(res) {
  // Must mirror set options or browsers keep the cookie (esp. SameSite=None in prod)
  res.clearCookie(REFRESH_COOKIE_NAME, {
    path: '/api/v1/auth',
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
  });
}

function resolveOAuthClientUrl(storedUrl) {
  if (storedUrl && isAllowedClientOrigin(storedUrl)) {
    return normalizeUrl(storedUrl);
  }
  return getClientBaseUrl();
}

function resolveGoogleErrorCode(err) {
  const msg = String(err?.message || '');
  if (err?.statusCode === 403) {
    if (msg.includes('expired')) return 'invite_expired';
    if (msg.startsWith('wrong_google_email') || msg.includes('wrong_google_email')) {
      return msg.startsWith('wrong_google_email') ? msg : `wrong_google_email: ${msg}`;
    }
    return 'not_invited';
  }
  if (err?.statusCode === 409) {
    return msg || 'google_account_in_use';
  }
  return msg || 'google_failed';
}

function sanitizeInviteToken(raw) {
  const token = String(raw || '').trim();
  // Invite tokens are 64-char hex, but allow a wider safe range for query/cookie transport
  if (token.length < 16 || token.length > 256) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  return token;
}

function inviteAcceptPath(inviteToken, errorCode = null) {
  const token = sanitizeInviteToken(inviteToken);
  if (!token) return null;
  const params = new URLSearchParams();
  params.set('token', token);
  if (errorCode) params.set('googleError', String(errorCode));
  return `/accept-invite?${params.toString()}`;
}

function clearGoogleOAuthCookies(res) {
  res.clearCookie(GOOGLE_STATE_COOKIE, { path: '/api/v1/auth' });
  res.clearCookie(GOOGLE_CLIENT_URL_COOKIE, { path: '/api/v1/auth' });
  res.clearCookie(GOOGLE_INVITE_TOKEN_COOKIE, { path: '/api/v1/auth' });
}

function loginRedirect(
  res,
  accessToken,
  errorCode,
  clientBase,
  user = null,
  inviteToken = null,
  returnTo = null
) {
  const base = resolveOAuthClientUrl(clientBase);
  if (errorCode) {
    const invitePath = inviteAcceptPath(inviteToken, errorCode);
    if (invitePath) {
      return res.redirect(`${base}${invitePath}`);
    }
    const loginUrl = new URL(`${base}/login`);
    loginUrl.searchParams.set('googleError', String(errorCode));
    if (returnTo && String(returnTo).startsWith('/')) {
      loginUrl.searchParams.set('next', String(returnTo));
    }
    return res.redirect(loginUrl.toString());
  }
  const url = new URL(`${base}/auth/google/callback`);
  url.searchParams.set('accessToken', accessToken);
  if (returnTo && String(returnTo).startsWith('/')) {
    url.searchParams.set('next', String(returnTo));
  }
  if (user) {
    const profile = Buffer.from(
      JSON.stringify({
        _id: user._id || user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatarUrl: user.avatarUrl ?? null,
        jobTitle: user.jobTitle ?? null,
      })
    ).toString('base64url');
    url.searchParams.set('profile', profile);
  }
  return res.redirect(url.toString());
}

async function register(req, res) {
  const { user, accessToken, refreshToken } = await authService.register(req.body);
  setRefreshCookie(res, refreshToken);
  res.status(httpStatus.StatusCodes.CREATED).json({
    success: true,
    message: 'Account created successfully',
    data: { user, accessToken, refreshToken },
  });
}

async function login(req, res) {
  const { user, accessToken, refreshToken } = await authService.login(req.body);
  setRefreshCookie(res, refreshToken);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: 'Logged in successfully',
    data: { user, accessToken, refreshToken },
  });
}

async function refresh(req, res) {
  // Cookie (browser) or body (Postman / mobile clients)
  const incomingToken =
    req.cookies?.[REFRESH_COOKIE_NAME] ||
    req.body?.refreshToken ||
    null;
  const { user, accessToken, refreshToken } = await authService.refresh(incomingToken);
  setRefreshCookie(res, refreshToken);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: 'Token refreshed',
    data: { user, accessToken, refreshToken },
  });
}

async function logout(req, res) {
  clearRefreshCookie(res);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: 'Logged out successfully',
  });
}

async function logoutAllDevices(req, res) {
  await authService.logoutAllDevices(req.user.id);
  clearRefreshCookie(res);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: 'Logged out from all devices',
  });
}

async function googleAuth(req, res) {
  const { user, accessToken, refreshToken } = await authService.googleAuth(req.body);
  setRefreshCookie(res, refreshToken);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: 'Signed in with Google',
    data: { user, accessToken, refreshToken },
  });
}

/**
 * Exchange a Google OAuth authorization code (or GIS credential) for session tokens.
 * Body: { code } OR { credential } (ID token).
 */
async function googleExchange(req, res) {
  const code = req.body?.code;
  const credential = req.body?.credential;

  let auth;
  if (code) {
    auth = await authService.googleAuthWithCode(String(code));
  } else if (credential) {
    auth = await authService.googleAuth({ credential: String(credential) });
  } else {
    return res.status(httpStatus.StatusCodes.BAD_REQUEST).json({
      success: false,
      message: 'Provide Google authorization code or credential',
      errors: [],
    });
  }

  setRefreshCookie(res, auth.refreshToken);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: 'Signed in with Google',
    data: {
      user: auth.user,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
    },
  });
}

/** Redirect browser to Google consent screen */
async function googleStart(req, res) {
  const clientUrl = resolveClientUrlFromRequest(req);
  const inviteToken = sanitizeInviteToken(req.query.inviteToken || req.query.token);
  let loginHint = String(req.query.loginHint || req.query.email || '')
    .trim()
    .toLowerCase();

  // Prefer email from the invite record so Google + match checks stay correct
  if (inviteToken) {
    try {
      const invite = await authService.resolveInviteByToken(inviteToken);
      if (invite?.email) loginHint = invite.email;
      else {
        // Invalid/expired invite — send back to accept page instead of Google
        return loginRedirect(
          res,
          null,
          'invite_expired',
          clientUrl,
          null,
          inviteToken
        );
      }
    } catch {
      /* still start Google with provided hint */
    }
  }

  const returnTo = (() => {
    const raw = String(req.query.next || req.query.returnTo || '').trim();
    if (!raw.startsWith('/') || raw.startsWith('//')) return null;
    if (raw.startsWith('/login') || raw.startsWith('/auth/')) return null;
    return raw.slice(0, 512);
  })();

  const state = authService.createOAuthState(clientUrl, {
    loginHint: loginHint || null,
    inviteToken,
    returnTo,
  });

  res.cookie(GOOGLE_STATE_COOKIE, state, {
    ...oauthCookieOptions,
    maxAge: 10 * 60 * 1000,
  });
  res.cookie(GOOGLE_CLIENT_URL_COOKIE, clientUrl, {
    ...oauthCookieOptions,
    maxAge: 10 * 60 * 1000,
  });
  if (inviteToken) {
    res.cookie(GOOGLE_INVITE_TOKEN_COOKIE, inviteToken, {
      ...oauthCookieOptions,
      maxAge: 10 * 60 * 1000,
    });
  }

  const url = authService.getGoogleAuthUrl(state, { loginHint });
  res.redirect(url);
}

/**
 * Invite-only Google start — validates the invite token before redirecting to Google.
 * GET /auth/google/invite?token=...&clientUrl=...
 */
async function googleInviteStart(req, res) {
  const clientUrl = resolveClientUrlFromRequest(req);
  const inviteToken = sanitizeInviteToken(req.query.token || req.query.inviteToken);
  if (!inviteToken) {
    return loginRedirect(res, null, 'invite_expired', clientUrl);
  }

  const invite = await authService.resolveInviteByToken(inviteToken);
  if (!invite?.email) {
    return loginRedirect(res, null, 'invite_expired', clientUrl, null, inviteToken);
  }

  // Re-enter the shared Google start with a verified invite
  req.query.inviteToken = inviteToken;
  req.query.loginHint = invite.email;
  req.query.clientUrl = clientUrl;
  return googleStart(req, res);
}

/** Google redirects here with ?code= */
async function googleCallback(req, res) {
  const cookieInvite = sanitizeInviteToken(req.cookies?.[GOOGLE_INVITE_TOKEN_COOKIE]);
  try {
    const { code, state, error } = req.query;

    if (error) {
      const savedClientUrl = req.cookies[GOOGLE_CLIENT_URL_COOKIE];
      let inviteToken = cookieInvite;
      let returnTo = null;
      try {
        const verified = authService.verifyOAuthState(state);
        inviteToken = sanitizeInviteToken(verified?.inviteToken) || cookieInvite;
        returnTo = verified?.returnTo || null;
      } catch {
        /* ignore */
      }
      clearGoogleOAuthCookies(res);
      return loginRedirect(res, null, String(error), savedClientUrl, null, inviteToken, returnTo);
    }

    const verifiedState = authService.verifyOAuthState(state);
    const savedClientUrl =
      verifiedState?.clientUrl || req.cookies[GOOGLE_CLIENT_URL_COOKIE];
    const inviteToken =
      sanitizeInviteToken(verifiedState?.inviteToken) || cookieInvite;
    const returnTo = verifiedState?.returnTo || null;
    clearGoogleOAuthCookies(res);

    if (!code || !verifiedState) {
      return loginRedirect(
        res,
        null,
        'invalid_state',
        savedClientUrl,
        null,
        inviteToken,
        returnTo
      );
    }

    const auth = await authService.googleAuthWithCode(String(code), {
      expectedEmail: verifiedState.loginHint || undefined,
      inviteToken: inviteToken || undefined,
    });
    setRefreshCookie(res, auth.refreshToken);
    return loginRedirect(
      res,
      auth.accessToken,
      null,
      savedClientUrl,
      auth.user,
      null,
      returnTo
    );
  } catch (err) {
    const message = resolveGoogleErrorCode(err);
    const savedClientUrl = req.cookies[GOOGLE_CLIENT_URL_COOKIE];
    let inviteToken = cookieInvite;
    let returnTo = null;
    try {
      const verifiedState = authService.verifyOAuthState(req.query.state);
      inviteToken = sanitizeInviteToken(verifiedState?.inviteToken) || cookieInvite;
      returnTo = verifiedState?.returnTo || null;
    } catch {
      /* ignore */
    }
    clearGoogleOAuthCookies(res);
    return loginRedirect(res, null, message, savedClientUrl, null, inviteToken, returnTo);
  }
}

async function forgotPassword(req, res) {
  const result = await authService.forgotPassword(req.body);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: result.message,
    data: {
      emailSent: result.emailSent,
      emailTo: result.emailTo,
      emailFrom: result.emailFrom,
      expiresInMinutes: result.expiresInMinutes,
      googleOnly: Boolean(result.googleOnly),
    },
  });
}

async function resetPassword(req, res) {
  const result = await authService.resetPassword(req.body);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: result.message,
  });
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  logoutAllDevices,
  googleAuth,
  googleExchange,
  googleStart,
  googleInviteStart,
  googleCallback,
  forgotPassword,
  resetPassword,
};
