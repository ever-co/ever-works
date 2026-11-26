import { BadRequestException, Logger } from '@nestjs/common';

import {
    assertK8sIngressHostAllowed,
    refusedK8sIngressHostRoot,
} from '../services/k8s-ingress-host.rule';

describe('k8s ingressHost save-time rule (PLATFORM_DOMAIN_NOT_ALLOWED)', () => {
    const NAMES = ['EVER_WORKS_DOMAIN', 'EVER_WORKS_APPS_DOMAIN', 'EVER_WORKS_APPS_MANAGED_DOMAIN'];
    const original: Record<string, string | undefined> = {};

    beforeEach(() => {
        jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        for (const name of NAMES) original[name] = process.env[name];
        process.env.EVER_WORKS_DOMAIN = 'ever.works';
        delete process.env.EVER_WORKS_APPS_DOMAIN;
        process.env.EVER_WORKS_APPS_MANAGED_DOMAIN = 'ever.app';
    });

    afterEach(() => {
        jest.restoreAllMocks();
        for (const name of NAMES) {
            if (original[name] === undefined) delete process.env[name];
            else process.env[name] = original[name];
        }
    });

    it.each([
        ['login.ever.works', 'ever.works'],
        ['Login.Ever.Works.', 'ever.works'],
        ['ever.works', 'ever.works'],
        ['shop.ever.app', 'ever.app'],
    ])('refuses a new %s', (host, root) => {
        expect(refusedK8sIngressHostRoot('k8s', { ingressHost: host })).toBe(root);
        expect(refusedK8sIngressHostRoot('k8s', { ingressHost: host }, {})).toBe(root);
        expect(
            refusedK8sIngressHostRoot(
                'k8s',
                { ingressHost: host },
                { ingressHost: 'old.ever.works' },
            ),
        ).toBe(root);
    });

    it('allows a value equal (after normalization) to a stored one, at any stored scope', () => {
        expect(
            refusedK8sIngressHostRoot(
                'k8s',
                { ingressHost: 'Compliance-Automation.Ever.Works' },
                { ingressHost: 'compliance-automation.ever.works' },
            ),
        ).toBeNull();
        // Work-scope save carrying the inherited user-scope value.
        expect(
            refusedK8sIngressHostRoot(
                'k8s',
                { ingressHost: 'compliance-automation.ever.works' },
                {},
                { ingressHost: 'compliance-automation.ever.works' },
            ),
        ).toBeNull();
    });

    it('allows a normal host, a lookalike, a cleared or blank value and no value at all', () => {
        expect(refusedK8sIngressHostRoot('k8s', { ingressHost: 'shop.example.com' })).toBeNull();
        expect(refusedK8sIngressHostRoot('k8s', { ingressHost: 'evil-ever.works' })).toBeNull();
        expect(refusedK8sIngressHostRoot('k8s', { ingressHost: null })).toBeNull();
        expect(refusedK8sIngressHostRoot('k8s', { ingressHost: '   ' })).toBeNull();
        expect(refusedK8sIngressHostRoot('k8s', { replicas: 2 })).toBeNull();
        expect(refusedK8sIngressHostRoot('k8s', undefined)).toBeNull();
    });

    it('applies to the k8s plugin only', () => {
        expect(refusedK8sIngressHostRoot('vercel', { ingressHost: 'login.ever.works' })).toBeNull();
        expect(
            refusedK8sIngressHostRoot('cloudflare-workers', { ingressHost: 'login.ever.works' }),
        ).toBeNull();
    });

    it('throws the coded 400 with the ingress-host sentence', () => {
        let caught: unknown;
        try {
            assertK8sIngressHostAllowed('k8s', { ingressHost: 'login.ever.works' }, {});
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(BadRequestException);
        expect((caught as BadRequestException).getStatus()).toBe(400);
        expect((caught as BadRequestException).getResponse()).toEqual({
            status: 'error',
            code: 'PLATFORM_DOMAIN_NOT_ALLOWED',
            message:
                "Hosts under ever.works can't be used as the default ingress host. Use the managed subdomain setting instead.",
        });
        expect(() =>
            assertK8sIngressHostAllowed('k8s', { ingressHost: 'shop.example.com' }),
        ).not.toThrow();
    });
});
