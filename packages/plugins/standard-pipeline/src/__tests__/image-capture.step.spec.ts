import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ImageCaptureStep } from '../steps/image-capture.step';
import type { StepExecutionContext, WorkReference, GenerationRequest, MutableItemData } from '@ever-works/plugin';
import type { MutableGenerationContext } from '../context/index.js';

describe('ImageCaptureStep', () => {
	let step: ImageCaptureStep;
	let mockContext: MutableGenerationContext;
	let mockExecContext: StepExecutionContext;

	const createMockLogger = () => ({
		log: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn()
	});

	const createMockScreenshotFacade = () => ({
		getSmartImage: vi.fn().mockResolvedValue({
			primaryImage: 'https://screenshots.example.com/image.png',
			source: 'screenshot'
		}),
		isAvailable: vi.fn().mockReturnValue(true),
		getActiveProviderName: vi.fn().mockResolvedValue('ScreenshotOne')
	});

	const createMockWork = (): WorkReference => ({
		id: 'test-dir-id',
		slug: 'test-work',
		name: 'Test Work'
	});

	const createMockRequest = (overrides?: Partial<GenerationRequest>): GenerationRequest =>
		({
			prompt: 'Test prompt',
			config: {
				capture_screenshots: true,
				...((overrides?.config as Record<string, unknown>) || {})
			},
			...overrides
		}) as GenerationRequest;

	const createMockItem = (name: string, source_url?: string, images?: string[]): MutableItemData =>
		({
			name,
			slug: name.toLowerCase().replace(/\s+/g, '-'),
			description: `Description for ${name}`,
			source_url,
			images
		}) as MutableItemData;

	const createMockContext = (overrides?: Partial<MutableGenerationContext>): MutableGenerationContext =>
		({
			work: createMockWork(),
			request: createMockRequest(),
			finalItems: [createMockItem('Test Item', 'https://example.com')],
			domainAnalysis: { domain_type: 'software', confidence: 0.9 },
			warnings: [],
			shouldStop: false,
			...overrides
		}) as MutableGenerationContext;

	const expectedFacadeOptions = { userId: 'test-user-id', workId: 'test-dir-id' };

	beforeEach(() => {
		step = new ImageCaptureStep();
		mockContext = createMockContext();
		mockExecContext = {
			logger: createMockLogger(),
			screenshotFacade: createMockScreenshotFacade(),
			user: { id: 'test-user-id' },
			work: { id: 'test-dir-id' }
		} as unknown as StepExecutionContext;
	});

	describe('Step Properties', () => {
		it('should have correct name', () => {
			expect(step.name).toBe('Image Capture');
		});
	});

	describe('run method', () => {
		it('should skip when capture_screenshots is disabled', async () => {
			mockContext.request = createMockRequest({
				config: { capture_screenshots: false }
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.screenshotFacade.getSmartImage).not.toHaveBeenCalled();
			expect(mockExecContext.logger.debug).toHaveBeenCalledWith(expect.stringContaining('disabled'));
			expect(result).toBe(mockContext);
		});

		it('should skip when screenshot service is not available and add warning', async () => {
			mockExecContext.screenshotFacade.isAvailable = vi.fn().mockReturnValue(false);

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.screenshotFacade.getSmartImage).not.toHaveBeenCalled();
			expect(mockExecContext.logger.warn).toHaveBeenCalledWith(expect.stringContaining('not configured'));
			expect(result.warnings).toContainEqual(expect.stringContaining('Screenshot provider is not configured'));
			expect(result).toBe(mockContext);
		});

		// Platform demo mode (`DEMO`): screenshots are off on a demo (design §5.2.4, ruling R41).
		// A screenshot provider always resolves now (Gotenberg is an auto-enabled system default),
		// and quick create sends `capture_screenshots: true` from the form's defaults, so the step
		// must skip on its own — whatever provider resolves, without asking the facade anything.
		describe('platform demo mode: screenshots are off', () => {
			afterEach(() => {
				vi.unstubAllEnvs();
			});

			it.each([['true'], ['1'], [' YES ']])(
				'with DEMO on (%s), skips even though a provider resolves (the Gotenberg default)',
				async (demo) => {
					vi.stubEnv('DEMO', demo);
					mockExecContext.screenshotFacade.getActiveProviderName = vi.fn().mockResolvedValue('Gotenberg');

					const result = await step.run(mockContext, mockExecContext);

					expect(mockExecContext.screenshotFacade.getSmartImage).not.toHaveBeenCalled();
					expect(mockExecContext.screenshotFacade.isAvailable).not.toHaveBeenCalled();
					expect(mockExecContext.screenshotFacade.getActiveProviderName).not.toHaveBeenCalled();
					expect(result).toBe(mockContext);
					expect(result.finalItems[0].images).toBeUndefined();
					// Placeholders are shown; there is nothing for the visitor to configure.
					expect(result.warnings).toEqual([]);
					expect(mockExecContext.logger.log).toHaveBeenCalledWith(
						'[test-work] Demo mode: screenshots are off, skipping image capture'
					);
				}
			);

			it('with DEMO on, skips when no provider resolves for the Work either', async () => {
				vi.stubEnv('DEMO', 'true');
				mockExecContext.screenshotFacade.getActiveProviderName = vi.fn().mockResolvedValue(null);

				const result = await step.run(mockContext, mockExecContext);

				expect(mockExecContext.screenshotFacade.getSmartImage).not.toHaveBeenCalled();
				expect(result.warnings).toEqual([]);
			});

			it.each([[undefined], ['false'], ['']])(
				'with DEMO unset (%s), captures with the provider that resolves, as before',
				async (demo) => {
					if (demo === undefined) vi.stubEnv('DEMO', undefined);
					else vi.stubEnv('DEMO', demo);
					mockExecContext.screenshotFacade.getActiveProviderName = vi.fn().mockResolvedValue('Gotenberg');

					const result = await step.run(mockContext, mockExecContext);

					expect(mockExecContext.screenshotFacade.getSmartImage).toHaveBeenCalledWith(
						{ url: 'https://example.com', domainType: 'software', itemName: 'Test Item' },
						expectedFacadeOptions
					);
					expect(result.finalItems[0].images).toEqual(['https://screenshots.example.com/image.png']);
					// The provider name is asked for only to label a failure, as before.
					expect(mockExecContext.screenshotFacade.getActiveProviderName).not.toHaveBeenCalled();
					expect(result.warnings).toEqual([]);
				}
			);

			it.each([[undefined], ['false'], ['']])(
				'with DEMO unset (%s), behaves exactly as before: tries every capture',
				async (demo) => {
					if (demo === undefined) vi.stubEnv('DEMO', undefined);
					else vi.stubEnv('DEMO', demo);
					mockExecContext.screenshotFacade.getActiveProviderName = vi.fn().mockResolvedValue(null);
					mockExecContext.screenshotFacade.getSmartImage = vi
						.fn()
						.mockRejectedValue(new Error('No screenshot provider'));

					const result = await step.run(mockContext, mockExecContext);

					expect(mockExecContext.screenshotFacade.getSmartImage).toHaveBeenCalledTimes(1);
					// Only the failure label asks for the provider name, as before.
					expect(mockExecContext.screenshotFacade.getActiveProviderName).toHaveBeenCalledTimes(1);
					expect(result.warnings).toEqual([
						'Screenshot capture failed for 1 item(s): No screenshot provider'
					]);
				}
			);
		});

		it('should skip when no domain analysis is available', async () => {
			mockContext.domainAnalysis = undefined;

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.screenshotFacade.getSmartImage).not.toHaveBeenCalled();
			expect(mockExecContext.logger.warn).toHaveBeenCalledWith(expect.stringContaining('No domain analysis'));
			expect(result).toBe(mockContext);
		});

		it('should capture images for items without images', async () => {
			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.screenshotFacade.getSmartImage).toHaveBeenCalledWith(
				{
					url: 'https://example.com',
					domainType: 'software',
					itemName: 'Test Item'
				},
				expectedFacadeOptions
			);
		});

		it('should skip items that already have images', async () => {
			mockContext.finalItems = [
				createMockItem('Item With Images', 'https://example.com', ['https://existing.com/img.png'])
			];

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.screenshotFacade.getSmartImage).not.toHaveBeenCalled();
		});

		it('should skip items without source_url', async () => {
			mockContext.finalItems = [createMockItem('Item No URL')];

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.screenshotFacade.getSmartImage).not.toHaveBeenCalled();
		});

		it('should add captured image to item images array', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems[0].images).toContain('https://screenshots.example.com/image.png');
		});

		it('should handle screenshot errors gracefully and add warning with provider name', async () => {
			mockExecContext.screenshotFacade.getSmartImage = vi.fn().mockRejectedValue(new Error('Screenshot failed'));

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Failed to capture image')
			);
			expect(result.finalItems[0].images).toBeUndefined();
			expect(result.warnings).toContainEqual(
				expect.stringContaining('Screenshot capture (ScreenshotOne) failed for 1 item(s)')
			);
		});

		it('should aggregate unique errors into a single warning', async () => {
			mockContext.finalItems = [
				createMockItem('Item 1', 'https://example1.com'),
				createMockItem('Item 2', 'https://example2.com'),
				createMockItem('Item 3', 'https://example3.com')
			];
			mockExecContext.screenshotFacade.getSmartImage = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));

			const result = await step.run(mockContext, mockExecContext);

			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]).toContain('Screenshot capture (ScreenshotOne) failed for 3 item(s)');
			expect(result.warnings[0]).toContain('401 Unauthorized');
		});

		it('should process multiple items', async () => {
			mockContext.finalItems = [
				createMockItem('Item 1', 'https://example1.com'),
				createMockItem('Item 2', 'https://example2.com'),
				createMockItem('Item 3', 'https://example3.com')
			];

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.screenshotFacade.getSmartImage).toHaveBeenCalledTimes(3);
		});

		it('should skip items without primary image in result', async () => {
			mockExecContext.screenshotFacade.getSmartImage = vi.fn().mockResolvedValue({
				primaryImage: null,
				source: 'none'
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems[0].images).toBeUndefined();
		});

		it('should log completion message', async () => {
			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.log).toHaveBeenCalledWith(expect.stringContaining('Image capture complete'));
		});

		it('should use domain type from domain analysis', async () => {
			mockContext.domainAnalysis = { domain_type: 'ecommerce', confidence: 0.8 };

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.screenshotFacade.getSmartImage).toHaveBeenCalledWith(
				expect.objectContaining({ domainType: 'ecommerce' }),
				expectedFacadeOptions
			);
		});

		it('should preserve existing images when adding new ones', async () => {
			mockContext.finalItems = [createMockItem('Item', 'https://example.com', [])];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems[0].images?.length).toBe(1);
		});
	});
});
