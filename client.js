/**
 * `dsh-ucloud` — Client half.
 *
 * Registers this bundle's settings form on its own page in the plugin list
 * (`plugins.bundle.config`, key `dsh-ucloud`): 学号 over this plugin's own
 * settings section, 密码 and the optional 验证码识别令牌 over the deployment's
 * credential store, and a login check against the Host's `/dsh-ucloud/verify`
 * route.
 *
 * The page holds no platform logic: reads and writes go through the shared
 * settings form and the credentials seam, so the Host half and the settings
 * page can never disagree about which account is configured.
 *
 * Plain JavaScript, no JSX and no imports: React and the settings primitives
 * come from the platform module table, and every colour is a `--dsw-*` theme
 * token so the card follows light/dark like the shipped pages.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ucloud',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    /** Dictionary namespace owned by this plugin. */
    const NS = 'settings.ucloud';
    /** Host plugin entry id; also the settings namespace the form edits. */
    const CONFIG_NS = 'ucloud';
    /** This plugin's own package name: the key `plugins.bundle.config` is addressed by. */
    const BUNDLE_PACKAGE = 'dsh-ucloud';
    /** Host route the login check calls. */
    const VERIFY_URL = '/dsh-ucloud/verify';
    /** Credential references (see the Host half). */
    const PASSWORD_REF = 'UCLOUD_PASSWORD';
    const OCR_TOKEN_REF = 'UCLOUD_OCR_TOKEN';

    /** English copy. */
    const en = {
      title: 'BUPT ucloud',
      description: 'Configure the BUPT 教学云 (ucloud) account DSH uses to read and submit coursework.',
      username: 'Student ID',
      usernameHint: 'The 统一认证 student id; stored in this profile.',
      password: 'Password',
      passwordHint: 'The 统一认证 password; stored in the credential store, never in a configuration file. Leave blank to keep the current one.',
      passwordSet: 'Password configured',
      passwordUnset: 'No password configured',
      ocrToken: 'Captcha OCR token',
      ocrHint: 'Byrdocs OCR token used to answer the 统一认证 captcha automatically. Optional, but most logins need one.',
      ocrSet: 'Configured',
      ocrUnset: 'Not configured',
      verify: 'Test sign-in',
      verifying: 'Signing in…',
      verifyOk: 'Signed in',
      verifyFailed: 'Sign-in check failed',
      saveFirst: 'Fix and save the form before testing the sign-in.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      invalid: 'Enter a value, or clear the field.',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      credNote: 'The password and OCR token are stored in the machine credential store; the student id is stored in the profile settings.',
    };

    /** Simplified Chinese copy. */
    const zh = {
      title: '教学云',
      description: '配置北邮教学云（ucloud）账号，供 DSH 查询课程作业并提交作业。',
      username: '学号',
      usernameHint: '统一认证学号，保存在当前配置档（profile）中。',
      password: '密码',
      passwordHint: '统一认证密码，保存在本机凭据库中，不会写入配置文件。留空表示保持当前密码。',
      passwordSet: '已配置密码',
      passwordUnset: '未配置密码',
      ocrToken: '验证码识别令牌',
      ocrHint: '登录统一认证遇到验证码时自动识别（Byrdocs OCR token）。可选，但多数情况下需要。',
      ocrSet: '已配置',
      ocrUnset: '未配置',
      verify: '测试登录',
      verifying: '正在登录…',
      verifyOk: '登录成功',
      verifyFailed: '登录校验失败',
      saveFirst: '请先修正并保存表单，再测试登录。',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalid: '请输入有效内容，或清空该字段。',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      credNote: '密码与验证码令牌保存在本机凭据库，学号保存在配置档设置中。',
    };

    /** The form frame's copy, read from this page's dictionary. */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      };
    }

    /** Card-local styles: spacing and tone only, every colour a theme token. */
    const CSS = `
.ucloud-note { margin:10px 0 0; font-size:12px; line-height:1.6; color:var(--dsw-alias-label-secondary); }
.ucloud-verify { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:14px; }
.ucloud-btn { appearance:none; font:inherit; font-size:12.5px; line-height:18px; padding:5px 12px; border-radius:var(--dsw-radius-sm); cursor:pointer; border:0.5px solid var(--dsw-alias-border-l3); background:transparent; color:var(--dsw-alias-label-primary); }
.ucloud-btn:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
.ucloud-btn:active:not(:disabled) { background:var(--dsw-alias-interactive-bg-active); }
.ucloud-btn:disabled { opacity:.4; cursor:not-allowed; }
.ucloud-result { margin:0; font-size:12px; }
.ucloud-result[data-tone="ok"] { color:var(--dsw-alias-state-success-primary); }
.ucloud-result[data-tone="error"] { color:var(--dsw-alias-state-error-primary); }
`;

    /**
     * The card's staged form over the `ucloud` settings section, the two
     * credential references, and the Host's login check.
     */
    class UcloudCardController {
      /**
       * @param scope - the bound settings form for the `ucloud` namespace.
       * @param ctx - the page plugin's context (credentials remote and locale).
       * @param t - the page's locale reader.
       */
      constructor(scope, ctx, t) {
        this.scope = scope;
        this.ctx = ctx;
        this.t = t;
        this.form = new primitives.SettingsFormModel(scope, [primitives.settingsTextField('username')], [
          { field: 'password', write: (text) => this.writeCredential(PASSWORD_REF, text) },
          { field: 'ocrToken', write: (text) => this.writeCredential(OCR_TOKEN_REF, text) },
        ]);
        /** Whether the Host reports a configured value for each reference. */
        this.credentials = {
          [PASSWORD_REF]: { configured: false, writable: true },
          [OCR_TOKEN_REF]: { configured: false, writable: true },
        };
        /** Last login-check outcome. */
        this.verify = { running: false, tone: '', text: '' };
        this.store = this.form.bind(() => this.projection());
        this.unsubscribe = scope.subscribe(() => { void this.readCredentials(); });
        void this.readCredentials();
      }

      /** What the card renders. */
      projection() {
        return {
          ...this.form.shell(),
          username: this.form.field('username'),
          password: this.form.field('password'),
          ocrToken: this.form.field('ocrToken'),
          passwordConfigured: this.credentials[PASSWORD_REF].configured,
          passwordWritable: this.credentials[PASSWORD_REF].writable,
          ocrConfigured: this.credentials[OCR_TOKEN_REF].configured,
          ocrWritable: this.credentials[OCR_TOKEN_REF].writable,
          verifyRunning: this.verify.running,
          verifyTone: this.verify.tone,
          verifyText: this.verify.text,
        };
      }

      /**
       * Ask the credentials seam whether the two references are configured.
       *
       * A value can be written from somewhere else, and the settings section
       * does not change when it is, so the page re-reads on every namespace
       * change and on the Host's own invalidation event.
       */
      async readCredentials() {
        try {
          const response = await this.ctx.remote.credentials.describe([PASSWORD_REF, OCR_TOKEN_REF]);
          if (!response || !response.ok) return;
          const view = response.value || {};
          this.credentials = {
            [PASSWORD_REF]: { configured: view[PASSWORD_REF]?.configured === true, writable: view[PASSWORD_REF]?.writable !== false },
            [OCR_TOKEN_REF]: { configured: view[OCR_TOKEN_REF]?.configured === true, writable: view[OCR_TOKEN_REF]?.writable !== false },
          };
          this.store.set(this.projection());
        } catch (_error) {
          // The seam is not reachable yet; the save path reports the failure.
        }
      }

      /**
       * Write one credential literal.
       * @param ref - credential reference.
       * @param value - the staged literal.
       * @returns whether the Host reports it configured afterwards.
       */
      async writeCredential(ref, value) {
        await this.ctx.remote.credentials.set(ref, value);
        await this.readCredentials();
        return this.credentials[ref].configured === true;
      }

      /**
       * Save any staged edit, then prove the stored credentials log in.
       *
       * The check always runs against what the Host holds, so a dirty form is
       * saved first; a form that cannot be saved refuses the check instead of
       * testing something the user did not submit.
       */
      async verifyLogin() {
        if (this.verify.running) return;
        this.verify = { running: true, tone: '', text: '' };
        this.store.set(this.projection());
        try {
          if (this.form.shell().dirty) {
            await this.form.save();
            if (this.form.shell().dirty || this.form.shell().failed) {
              this.verify = { running: false, tone: 'error', text: this.t('saveFirst') };
              return;
            }
          }
          const response = await fetch(VERIFY_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          const data = await response.json().catch(() => undefined);
          if (data && data.ok) {
            const value = data.value || {};
            const who = value.realName || value.userName || '';
            const roles = Array.isArray(value.roles) && value.roles.length > 0 ? `（${value.roles.join('、')}）` : '';
            this.verify = { running: false, tone: 'ok', text: `${this.t('verifyOk')}：${who}${roles}` };
          } else {
            this.verify = {
              running: false,
              tone: 'error',
              text: `${this.t('verifyFailed')}：${data?.error?.message ?? response.status}`,
            };
          }
        } catch (error) {
          this.verify = { running: false, tone: 'error', text: `${this.t('verifyFailed')}：${String(error?.message ?? error)}` };
        } finally {
          this.store.set(this.projection());
        }
      }

      /** The face the card's slot registration injects. */
      inject() {
        return {
          hooks: { ucloudCard: this.store },
          ...this.form.actions(),
          verifyLogin: () => { void this.verifyLogin(); },
        };
      }

      /** Release configuration subscriptions. */
      dispose() {
        this.unsubscribe();
        this.form.dispose();
      }
    }

    /**
     * Render the card's one-liner or its settings form, as the Plugins page asks.
     * @param props - the view asked for, locale copy, the form snapshot, and its actions.
     * @returns the one-liner, or the form.
     */
    function UcloudCard(props) {
      const { t } = props;
      const state = props.useUcloudCard((snapshot) => snapshot);
      if (props.view === 'summary') return t('description');
      return h(primitives.SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
      },
        // `data-plugin` matches the module system's own style ownership marker,
        // so a bundle reload drops this tag with the card.
        h('style', { 'data-plugin': 'dsh-ucloud' }, CSS),
        h(primitives.SettingsValueField, {
          id: 'plugin-config-ucloud-username',
          label: t('username'),
          hint: t('usernameHint'),
          overriddenLabel: t('overridden'),
          resetLabel: t('reset'),
          invalidLabel: t('invalid'),
          disabled: !state.writable,
          ...state.username,
          onEdit: (text) => { props.edit('username', text); },
          onReset: () => { props.resetField('username'); },
        }),
        h(primitives.SettingsSecretField, {
          id: 'plugin-config-ucloud-password',
          label: t('password'),
          hint: t('passwordHint'),
          disabled: !state.passwordWritable,
          text: state.password.text,
          configured: state.passwordConfigured,
          stateLabel: state.passwordConfigured ? t('passwordSet') : t('passwordUnset'),
          onEdit: (text) => { props.edit('password', text); },
        }),
        h(primitives.SettingsSecretField, {
          id: 'plugin-config-ucloud-ocr',
          label: t('ocrToken'),
          hint: t('ocrHint'),
          disabled: !state.ocrWritable,
          text: state.ocrToken.text,
          configured: state.ocrConfigured,
          stateLabel: state.ocrConfigured ? t('ocrSet') : t('ocrUnset'),
          onEdit: (text) => { props.edit('ocrToken', text); },
        }),
        h('div', { className: 'ucloud-verify' },
          h('button', {
            type: 'button',
            className: 'ucloud-btn',
            disabled: !state.writable || state.verifyRunning,
            onClick: () => { props.verifyLogin(); },
          }, state.verifyRunning ? t('verifying') : t('verify')),
          state.verifyText
            ? h('p', { className: 'ucloud-result', 'data-tone': state.verifyTone === 'ok' ? 'ok' : 'error', role: 'status' }, state.verifyText)
            : null,
        ),
        h('p', { className: 'ucloud-note' }, t('credNote')),
      );
    }

    /** Required services (cordis fiber inject). */
    const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms'];

    /**
     * Mount this bundle's settings form on its own page in the plugin list.
     *
     * The slot is `plugins.bundle.config`, keyed by the bundle's package name:
     * `plugins.item` is the Official group, reserved for the shipped settings
     * pages, and a bundle's own configuration belongs on the bundle's page.
     *
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ucloud: dictionaries');
      const card = new UcloudCardController(ctx.configForms.get(CONFIG_NS), ctx, t);
      ctx.effect(() => () => { card.dispose(); }, 'dsh-ucloud: form subscription');
      ctx.effect(() => ctx.remote.$on('credentials/reference-updated', (ref) => {
        if (ref === PASSWORD_REF || ref === OCR_TOKEN_REF) void card.readCredentials();
      }), 'dsh-ucloud: credential invalidations');
      ctx.effect(() => ctx.configForms.whileServed([CONFIG_NS], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE_PACKAGE,
        locale: NS,
        inject: () => card.inject(),
      }, UcloudCard))), 'dsh-ucloud: settings page');
    }

    return { NS, CONFIG_NS, BUNDLE_PACKAGE, VERIFY_URL, PASSWORD_REF, OCR_TOKEN_REF, inject, apply };
  },
});
