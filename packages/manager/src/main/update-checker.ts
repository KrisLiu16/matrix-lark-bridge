import { app, shell } from 'electron';
import semver from 'semver';

const UPDATE_APP_TOKEN = 'M3YDb8oFVasbw6sTcDYcWCPinPg';
const UPDATE_TABLE_ID = 'tblhmvDbb8W5uIvn';
const FEISHU_API_BASE = 'https://open.feishu.cn';

export interface UpdateInfo {
  hasUpdate: boolean;
  forceUpdate: boolean;
  version: string;
  notes: string;
  downloadUrl: string;
  publishDate: string;
}

const NO_UPDATE: UpdateInfo = {
  hasUpdate: false,
  forceUpdate: false,
  version: '',
  notes: '',
  downloadUrl: '',
  publishDate: '',
};

async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const res = await fetch(`${FEISHU_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = (await res.json()) as { tenant_access_token?: string; code?: number; msg?: string };
  if (!data.tenant_access_token) {
    throw new Error(`Failed to get tenant_access_token: ${data.msg ?? 'unknown'}`);
  }
  return data.tenant_access_token;
}

export async function checkForUpdate(appId: string, appSecret: string): Promise<UpdateInfo> {
  const currentVersion = app.getVersion();

  const token = await getTenantAccessToken(appId, appSecret);

  // Query bitable for the record with 状态="最新"
  const filter = encodeURIComponent('AND(CurrentValue.[状态]="最新")');
  const url = `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${UPDATE_APP_TOKEN}/tables/${UPDATE_TABLE_ID}/records?filter=${filter}&page_size=1`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json()) as any;

  const record = data?.data?.items?.[0]?.fields;
  if (!record) {
    console.log('[update-checker] no latest version record found');
    return NO_UPDATE;
  }

  const latestVersion = record['版本号'] as string;
  if (!latestVersion || !semver.valid(latestVersion)) {
    console.warn('[update-checker] invalid version in bitable:', latestVersion);
    return NO_UPDATE;
  }

  if (!semver.gt(latestVersion, currentVersion)) {
    console.log(`[update-checker] up to date (current=${currentVersion}, latest=${latestVersion})`);
    return NO_UPDATE;
  }

  const minVersion = record['最低兼容版本'] as string | undefined;
  const forceFlag = record['是否强制更新'] as string | undefined;
  const forceUpdate =
    forceFlag === '是' || (!!minVersion && semver.valid(minVersion) && semver.lt(currentVersion, minVersion));

  const downloadLink = record['下载链接'];
  const downloadUrl = typeof downloadLink === 'object' ? downloadLink?.link : (downloadLink ?? '');

  console.log(`[update-checker] new version available: ${latestVersion} (current=${currentVersion}, force=${forceUpdate})`);

  return {
    hasUpdate: true,
    forceUpdate: !!forceUpdate,
    version: latestVersion,
    notes: (record['更新内容'] as string) ?? '',
    downloadUrl,
    publishDate: record['发布日期'] ? new Date(record['发布日期']).toLocaleDateString() : '',
  };
}

export function openDownloadUrl(url: string): void {
  if (url) shell.openExternal(url);
}
