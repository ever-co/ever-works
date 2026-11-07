import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AboutView, type AboutBuild } from '@/components/about/AboutView';
import {
    buildGitHubLinks,
    compareBuilds,
    resolveDeploymentEnvironment,
    resolveDisplayApiAddress,
} from '@/lib/about-info';
import { getWebBuildInfo } from '@/lib/build-info';
import { versionAPI } from '@/lib/api';
import { API_URL, COMPANY_OWNER_WEBSITE, WEB_URL } from '@/lib/constants';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('about') };
}

const WEBSITE_URL = 'https://ever.works';
const DOCS_URL = 'https://docs.ever.works';
const COMPANY_URL = 'https://ever.co';

function toBuild(info: AboutBuild): AboutBuild {
    return {
        version: info.version,
        shortSha: info.shortSha,
        gitRef: info.gitRef,
        buildTime: info.buildTime,
        commitUrl: info.commitUrl,
    };
}

/**
 * About — `/about`, inside the dashboard shell and behind its session check:
 * the product, which web and API builds are running (and whether they come
 * from the same commit), the environment, and the project's links.
 *
 * `GET /api/version` is the same public, five-minute-cached call the footer
 * makes, deduped per render; when it fails the API row says so and the page
 * still renders.
 */
export default async function AboutPage() {
    const web = getWebBuildInfo();
    const api = await versionAPI.get();

    return (
        <AboutView
            web={toBuild(web)}
            api={api ? toBuild(api) : null}
            sync={compareBuilds(web, api)}
            buildMode={process.env.NODE_ENV === 'production' ? 'production' : 'development'}
            environment={resolveDeploymentEnvironment({
                override: process.env.NEXT_PUBLIC_APP_ENV,
                webUrl: WEB_URL,
                buildRef: web.gitRef,
            })}
            apiAddress={resolveDisplayApiAddress({
                publicApiUrl: process.env.NEXT_PUBLIC_API_URL,
                serverApiUrl: API_URL,
                webUrl: WEB_URL,
            })}
            github={buildGitHubLinks(process.env.NEXT_PUBLIC_GITHUB_REPO_URL)}
            learnMore={{
                website: WEBSITE_URL,
                docs: DOCS_URL,
                // A white-label install names its own owner site; Ever Works' own is ever.co.
                company:
                    COMPANY_OWNER_WEBSITE === WEBSITE_URL ? COMPANY_URL : COMPANY_OWNER_WEBSITE,
            }}
        />
    );
}
