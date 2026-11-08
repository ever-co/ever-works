import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AboutView } from '@/components/about/AboutView';
import {
    buildGitHubLinks,
    buildLearnMoreLinks,
    compareBuilds,
    resolveDeploymentEnvironment,
    resolveDisplayApiAddress,
    toAboutBuild,
    type AboutBuild,
} from '@/lib/about-info';
import { getWebBuildInfo } from '@/lib/build-info';
import { versionAPI } from '@/lib/api';
import { API_URL, COMPANY_OWNER, COMPANY_OWNER_WEBSITE, WEB_URL } from '@/lib/constants';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('about') };
}

const UNKNOWN_BUILD: AboutBuild = {
    version: '0.0.0',
    shortSha: 'dev',
    gitRef: '',
    buildTime: '',
    commitUrl: null,
};

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
            web={toAboutBuild(web) ?? UNKNOWN_BUILD}
            api={toAboutBuild(api)}
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
            learnMore={buildLearnMoreLinks({
                webUrl: WEB_URL,
                companyOwnerWebsite: COMPANY_OWNER_WEBSITE,
                companyOwnerName: COMPANY_OWNER,
            })}
        />
    );
}
