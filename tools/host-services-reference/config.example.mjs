// Copy outside the repository; inject secrets from your backend secret manager.
// Never bundle this module, issuer secret or app client secrets into a host/guest app.
import { readFileSync } from 'node:fs';
const pem = name => readFileSync(process.env[name], 'utf8');
export default {
  host: '127.0.0.1', port: 8787,
  database: process.env.HOST_SERVICES_DATABASE ?? './host-services.sqlite',
  issuerSecret: process.env.HOST_IDENTITY_ISSUER_SECRET,
  identitySecret: process.env.HOST_PAIRWISE_ID_SECRET,
  applications: [{
    miniAppId: 'sample-miniapp', publisherId: 'sample-publisher', identityProtocol: '2.0',
    hostAppId: 'sample-host', tenantId: 'sample-tenant', environment: 'develop',
    clientId: 'sample-miniapp-backend', clientSecret: process.env.MINIAPP_CLIENT_SECRET,
    trustedPackRoots: [process.env.MINIAPP_VERIFIED_PACK_ROOT],
    allowedPaymentChannels: ['reference'],
    authorizationPolicies: {
      profile: { purpose: '在此小程序展示您的昵称和头像', permissionVersion: '1' },
      phone: { purpose: '在此小程序关联您的已验证手机号', permissionVersion: '1' },
    },
  }],
  payments: {
    reference: { callbackSecret: process.env.REFERENCE_PAYMENT_CALLBACK_SECRET },
    // Enable only after merchant onboarding, product permissions and certificate setup.
    // wechat: {
    //   mchid: process.env.WECHAT_MCHID, serialNo: process.env.WECHAT_MERCHANT_CERT_SERIAL,
    //   privateKey: pem('WECHAT_MERCHANT_PRIVATE_KEY_FILE'), apiV3Key: process.env.WECHAT_API_V3_KEY,
    //   appIds: { app: process.env.WECHAT_APP_ID, jsapi: process.env.WECHAT_JSAPI_APP_ID,
    //     h5: process.env.WECHAT_H5_APP_ID, native: process.env.WECHAT_NATIVE_APP_ID },
    //   platformKeys: { [process.env.WECHAT_PLATFORM_KEY_SERIAL]: pem('WECHAT_PLATFORM_PUBLIC_KEY_FILE') },
    //   notifyUrl: 'https://your-backend.example/v1/payments/callbacks/wechat',
    // },
    // alipay: {
    //   appId: process.env.ALIPAY_APP_ID, sellerId: process.env.ALIPAY_SELLER_ID,
    //   privateKey: pem('ALIPAY_MERCHANT_PRIVATE_KEY_FILE'), publicKey: pem('ALIPAY_PUBLIC_KEY_FILE'),
    //   notifyUrl: 'https://your-backend.example/v1/payments/callbacks/alipay',
    //   gateway: 'https://openapi.alipay.com/gateway.do',
    // },
  },
};
