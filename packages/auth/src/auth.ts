import fs from 'fs/promises';
import path from 'path';
import express from 'express';
import { existsSync } from 'fs';
import { generateId, logger, ServerError, matchMaker } from '@colyseus/core';
import { Request } from 'express-jwt';
import { OAuthProviderCallback, oAuthProviderCallback, oauth } from './oauth';
import { JWT, JwtPayload } from './JWT';
import { Hash } from './Hash';

export type RegisterWithEmailAndPasswordCallback<T = any> = (email: string, password: string, options: T) => Promise<unknown>;
export type RegisterAnonymouslyCallback<T = any> = (options: T) => Promise<unknown>;
export type FindUserByEmailCallback = (email: string) => Promise<unknown & { password: string }>;
export type ParseTokenCallback = (token: JwtPayload) => Promise<unknown> | unknown;
export type ForgotPasswordCallback = (email: string, htmlContents: string, resetPasswordLink: string) => Promise<boolean | unknown>;
export type ResetPasswordCallback = (email: string, password: string) => Promise<unknown>;
export type GenerateTokenCallback = (userdata: unknown) => Promise<unknown>;
export type HashPasswordCallback = (password: string) => Promise<string>;

export interface AuthSettings {
  onFindUserByEmail: FindUserByEmailCallback,
  onRegisterWithEmailAndPassword: RegisterWithEmailAndPasswordCallback,
  onRegisterAnonymously: RegisterAnonymouslyCallback,

  onForgotPassword?: ForgotPasswordCallback,
  onResetPassword?: ResetPasswordCallback,

  onOAuthProviderCallback?: OAuthProviderCallback,
  onParseToken?: ParseTokenCallback,
  onGenerateToken?: GenerateTokenCallback,
  onHashPassword?: HashPasswordCallback,
};

let onFindUserByEmail: FindUserByEmailCallback = (email: string) => { throw new Error('`auth.settings.onFindByEmail` not implemented.'); };
let onRegisterWithEmailAndPassword: RegisterWithEmailAndPasswordCallback = () => { throw new Error('`auth.settings.onRegister` not implemented.'); };
let onForgotPassword: ForgotPasswordCallback = () => { throw new Error('`auth.settings.onForgotPassword` not implemented.'); };
let onParseToken: ParseTokenCallback = (jwt: JwtPayload) => jwt;
let onGenerateToken: GenerateTokenCallback = async (userdata: unknown) => await JWT.sign(userdata);
let onHashPassword: HashPasswordCallback = async (password: string) => Hash.make(password);

/**
 * Detect HTML template path (for password reset form)
 */
const htmlTemplatePath = [
  path.join(process.cwd(), "html"),
  path.join(__dirname, "..", "html"),
].find((filePath) => existsSync(filePath));

const RESET_PASSWORD_TOKEN_EXPIRATION_MINUTES = 30;

export const auth = {
  /**
   * OAuth utilities
   */
  oauth: oauth,

  settings: {
    /**
     * Find user by email.
     */
    onFindUserByEmail,

    /**
     * Register user by email and password.
     */
    onRegisterWithEmailAndPassword,

    /**
     * (Optional) Register anonymous user.
     */
    onRegisterAnonymously: undefined as RegisterAnonymouslyCallback,

    /**
     * (Optional) Send reset password link via email.
     */
    onForgotPassword,

    /**
     * (Optional) Reset password action.
     */
    onResetPassword: undefined as ResetPasswordCallback,

    /**
     * By default, it returns the contents of the JWT token. (onGenerateToken)
     */
    onParseToken,

    /**
     * By default, it encodes the full `userdata` object into the JWT token.
     */
    onGenerateToken,

    /**
     * Hash password before storing it. By default, it uses SHA1 + process.env.AUTH_SALT.
     */
    onHashPassword,
  } as AuthSettings,

  prefix: "/auth",
  middleware: JWT.middleware,

  routes: function (settings: Partial<AuthSettings> = {}) {
    const router = express.Router();

    // set register/login callbacks
    Object.keys(settings).forEach(key => {
      auth.settings[key] = settings[key];
    });

    if (!auth.settings.onParseToken) {
      auth.settings.onParseToken = onParseToken;
    }
    if (!auth.settings.onGenerateToken) {
      auth.settings.onGenerateToken = onGenerateToken;
    }
    if (!auth.settings.onHashPassword) {
      auth.settings.onHashPassword = onHashPassword;
    }

    /**
     * OAuth (optional)
     */
    if (settings.onOAuthProviderCallback) {
      oauth.onCallback(settings.onOAuthProviderCallback);
    }

    if (oAuthProviderCallback) {
      const prefix = oauth.prefix;

      // make sure oauth.prefix contains the full prefix
      oauth.prefix = auth.prefix + prefix;

      router.use(prefix, oauth.routes());
    }

    /**
     * Get user data from JWT token.
     */
    router.get("/userdata", auth.middleware(), async (req: Request, res) => {
      try {
        res.json({ user: await auth.settings.onParseToken(req.auth), });
      } catch (e) {
        res.status(401).json({ error: e.message });
      }
    });

    /**
     * Login user by email and password.
     */
    router.post("/login", express.json(), async (req, res) => {
      try {
        const email = req.body.email;
        if (!isValidEmail(email)) { throw new Error("email_malformed"); }

        const user = await auth.settings.onFindUserByEmail(email);
        if (user.password === Hash.make(req.body.password)) {
          delete user.password; // remove password from response
          res.json({ user, token: await auth.settings.onGenerateToken(user) });

        } else {
          throw new Error("invalid_credentials");
        }

      } catch (e) {
        logger.error(e);
        res.status(401).json({ error: e.message });
      }
    });

    /**
     * Register user by email and password.
     */
    router.post("/register", express.json(), async (req, res) => {
      const email = req.body.email;
      const password = req.body.password;

      if (!isValidEmail(email)) {
        return res.status(400).json({ error: "email_malformed" });
      }

      let existingUser: any;
      try {
        existingUser = await auth.settings.onFindUserByEmail(email)

      } catch (e) {
        logger.error('@colyseus/auth, onFindByEmail exception:' + e.stack);
      }

      try {
        // TODO: allow to set password on existing user, if valid token is equivalent to email
        //  (existingUser.password && existingUser.password.length > 0)
        if (existingUser) {
          throw new Error("email_already_in_use");
        }

        if (!isValidPassword(password)) {
          return res.status(400).json({ error: "password_too_short" });
        }

        // Register
        await auth.settings.onRegisterWithEmailAndPassword(email, Hash.make(password), req.body.options);

        const user = await auth.settings.onFindUserByEmail(email);
        delete user.password; // remove password from response

        const token = await auth.settings.onGenerateToken(user);
        res.json({ user, token, });

      } catch (e) {
        logger.error(e);
        res.status(401).json({ error: e.message });
      }
    });

    /**
     * Anonymous sign-in
     */
    router.post("/anonymous", express.json(), async (req, res) => {
      const options = req.body.options;

      // register anonymous user, if callback is defined.
      const user = (auth.settings.onRegisterAnonymously)
        ? await auth.settings.onRegisterAnonymously(options)
        : { ...options, id: undefined, anonymousId: generateId(21), anonymous: true }

      res.json({
        user,
        token: await onGenerateToken(user)
      });
    });

    router.post("/forgot-password", express.json(), async (req, res) => {
      try {
        //
        // check if "forgot password" feature is fully implemented
        //
        if (typeof (auth.settings.onForgotPassword) !== "function") {
          throw new Error("auth.settings.onForgotPassword must be implemented.");
        }

        if (typeof (auth.settings.onResetPassword) !== "function") {
          throw new Error("auth.settings.onResetPassword must be implemented.");
        }

        const email = req.body.email;
        const user = await auth.settings.onFindUserByEmail(email);
        if (!user) {
          throw new Error("email_not_found");
        }

        const token = await JWT.sign({ email }, { expiresIn: RESET_PASSWORD_TOKEN_EXPIRATION_MINUTES + "m" });

        const fullUrl = req.protocol + '://' + req.get('host');
        const passwordResetLink = fullUrl + auth.prefix + "/reset-password?token=" + token;

        const htmlEmail = (await fs .readFile(path.join(htmlTemplatePath, "reset-password-email.html"), "utf-8"))
          .replace("[PASSWORD_RESET_LINK]", passwordResetLink);

        const result = (await auth.settings.onForgotPassword(email, htmlEmail, passwordResetLink)) ?? true;
        res.json(result);

      } catch (e) {
        res.status(401).json({ error: e.message });
      }
    });

    // reset password form
    router.get("/reset-password", async (req, res) => {
      try {
        const token = (req.query.token || "").toString();

        const htmlForm = (await fs.readFile(path.join(htmlTemplatePath, "reset-password-form.html"), "utf-8"))
          .replace("[ACTION]", auth.prefix + "/reset-password")
          .replace("[TOKEN]", token);

        res
          .set("content-type", "text/html")
          .send(htmlForm);

      } catch (e) {
        logger.debug(e);
        res.end(`Error: ${e.message}`);
      }
    });

    // reset password form ACTION
    router.post("/reset-password", express.urlencoded({ extended: false }), async (req, res) => {
      const token = req.body.token;
      const password = req.body.password;

      try {
        const data = await JWT.verify<{ email: string }>(token);

        if (matchMaker.presence?.get("reset-password:" + token)) {
          throw new Error("token_already_used");
        }

        if (!isValidPassword(password)) {
          throw new Error("Password is too short.");
        }

        const result = await auth.settings.onResetPassword(data.email, Hash.make(password)) ?? true;

        // invalidate used token for 30m
        matchMaker.presence?.setex("reset-password:" + token, "1", 60 * RESET_PASSWORD_TOKEN_EXPIRATION_MINUTES);

        res.redirect(auth.prefix + "/reset-password?success=" + (result || "Password reset successfully!"));

      } catch (e) {
        res.redirect(auth.prefix + "/reset-password?token=" + token + "&error=" + e.message);
      }
    });

    return router;
  },
};

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)
}

function isValidPassword(password: string) {
  return password.length >= 6;
}