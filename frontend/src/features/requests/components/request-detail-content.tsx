import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { format } from 'date-fns';
import { DashboardIcon } from '@radix-ui/react-icons';
import { zhCN, enUS } from 'date-fns/locale';
import { Copy, Clock, Database, FileText, Layers, Download, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { extractNumberID } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { JsonViewer } from '@/components/json-tree-view';
import { useGeneralSettings } from '@/features/system/data/system';
import { getTokenFromStorage } from '@/stores/authStore';
import { useUsageLogs } from '../data/usage-logs';
import { type Request, useRequest, useRequestExecutions } from '../data';
import { ChunksDialog } from './chunks-dialog';
import { CurlPreviewDialog } from './curl-preview-dialog';
import { getStatusColor } from './help';
import { RequestConversationViewer } from './request-conversation-viewer';
import { ResponseFlow } from './response-flow';
import { parseResponse } from '../utils/response-parser';
import { parseRequestConversation } from '../utils/request-conversation';
import { generateRequestCurl, generateExecutionCurl } from '../utils/curl-generator';

interface RequestDetailContentProps {
  requestId: string;
  projectId?: string | null;
  previewRequest?: Request | null;
  isPreviewStreaming?: boolean;
}

export function RequestDetailContent({ requestId, projectId, previewRequest, isPreviewStreaming = false }: RequestDetailContentProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'zh' ? zhCN : enUS;

  const [showResponseChunks, setShowResponseChunks] = useState(false);
  const [showExecutionChunks, setShowExecutionChunks] = useState(false);
  const [selectedResponseChunks, setSelectedResponseChunks] = useState<any[]>([]);
  const [selectedExecutionChunks, setSelectedExecutionChunks] = useState<any[]>([]);
  const [showCurlPreview, setShowCurlPreview] = useState(false);
  const [curlCommand, setCurlCommand] = useState('');
  const [isDownloadingVideo, setIsDownloadingVideo] = useState(false);
  const [audioObjectUrl, setAudioObjectUrl] = useState<string | null>(null);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [audioLoadFailed, setAudioLoadFailed] = useState(false);
  const [responseView, setResponseView] = useState<'preview' | 'json'>('preview');
  const [requestBodyView, setRequestBodyView] = useState<'conversation' | 'json'>('conversation');

  const { data: settings } = useGeneralSettings();
  const { data: requestData, isLoading } = useRequest(requestId, { projectId, disableAutoRefresh: isPreviewStreaming });
  const request = previewRequest ?? requestData;

  // Auto-select the appropriate request-body view once data is available:
  // use the conversation view only when the body actually parses as a conversation.
  // Only auto-adjust when the underlying request body changes, so manual toggles stick.
  const lastAutoBodyRef = useRef<string>('');
  useEffect(() => {
    if (!request) return;
    const bodyKey = JSON.stringify({ id: request?.id, body: request?.requestBody, format: request?.format });
    if (bodyKey === lastAutoBodyRef.current) return;
    lastAutoBodyRef.current = bodyKey;
    const isConversation = !!parseRequestConversation(request.requestBody, request.format);
    setRequestBodyView(isConversation ? 'conversation' : 'json');
  }, [request?.id, request?.requestBody, request?.format]);
  const {
    data: executions,
    isLoading: isExecutionsLoading,
    isError: isExecutionsError,
  } = useRequestExecutions(
    requestId,
    {
      first: 10,
      orderBy: { field: 'CREATED_AT', direction: 'DESC' },
    },
    { projectId }
  );
  const { data: usageLogs } = useUsageLogs(
    {
      first: 1,
      where: { requestID: requestId },
      orderBy: { field: 'CREATED_AT', direction: 'DESC' },
    },
    { projectId, enabled: true }
  );

  const parsedResponse = useMemo(() => {
    if (!request) return { content: '', reasoning: '', toolCalls: [] };
    if (previewRequest) {
      return parseResponse(undefined, previewRequest.responseChunks);
    }
    return parseResponse(request.responseBody, request.responseChunks);
  }, [previewRequest, request]);

  const hasPreviewData = !!(parsedResponse.content || parsedResponse.reasoning || parsedResponse.toolCalls.length > 0);
  const isLive = isPreviewStreaming || !!(request?.status === 'processing' && request?.stream);
  const hasResponseBody = !!(request?.responseBody && Object.keys(request.responseBody).length > 0);
  const hasResponseChunks = !!(request?.responseChunks && request.responseChunks.length > 0);
  const responseHeaders = executions?.edges?.[0]?.node?.responseHeaders;

  const extractResponseText = useCallback(() => {
    if (!request) return '';
    const { content, reasoning, toolCalls } = parsedResponse;

    let result = '';
    if (reasoning) {
      result += `${reasoning}\n\n`;
    }
    if (content) {
      result += content;
    }
    if (toolCalls.length > 0) {
      if (result) result += '\n\n';
      result += toolCalls.map(tc => {
        return `Tool Call: ${tc.function?.name}\nArguments: ${tc.function?.arguments}`;
      }).join('\n\n');
    }

    return result.trim();
  }, [request, parsedResponse]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success(t('requests.actions.copy'));
  };

  const downloadFile = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(t('requests.actions.download'));
  };

  const isSpeechRequest = request?.format === 'openai/audio_speech';
  const isVideoRequest = request?.format === 'openai/video' || request?.format === 'seedance/video';
  const hasStoredContent = !!(request?.contentSaved && request?.contentStorageKey);

  // fetchStoredContent downloads the binary artifact (video/audio) saved to external storage
  // via the content-type-agnostic /admin/requests/:id/content endpoint.
  const fetchStoredContent = useCallback(async (): Promise<{ blob: Blob; filename: string } | null> => {
    if (!request?.contentSaved || !request?.contentStorageKey || !projectId) return null;

    const requestIdNumber = extractNumberID(request.id);
    if (!requestIdNumber) return null;

    const token = getTokenFromStorage();
    if (!token) {
      toast.error(t('common.errors.sessionExpiredSignIn'));
      return null;
    }

    const url = `/admin/requests/${encodeURIComponent(requestIdNumber)}/content`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Project-ID': projectId,
      },
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const contentDisposition = resp.headers.get('Content-Disposition') || '';
    const filenameMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
    // Return empty string when the header is absent so callers can apply their own
    // extension-aware fallback (e.g. .mp4 for video, .mp3 for audio). A non-empty
    // generic fallback here would silently shadow those defaults.
    const filename = filenameMatch?.[1] ?? '';
    const blob = await resp.blob();

    return { blob, filename };
  }, [request, projectId, t]);

  const downloadVideo = async () => {
    if (!hasStoredContent || !projectId) return;

    const requestIdNumber = extractNumberID(request.id);
    if (!requestIdNumber) return;

    try {
      setIsDownloadingVideo(true);

      const result = await fetchStoredContent();
      if (!result) return;

      const filename = result.filename || `video-${requestIdNumber}.mp4`;
      const objectUrl = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
      toast.success(t('requests.actions.download'));
    } catch (_err) {
      toast.error(t('common.errors.operationFailed', { operation: t('requests.actions.downloadVideo') }));
    } finally {
      setIsDownloadingVideo(false);
    }
  };

  const downloadAudio = async () => {
    if (!hasStoredContent || !projectId) return;

    const requestIdNumber = extractNumberID(request.id);
    if (!requestIdNumber) return;

    try {
      setIsLoadingAudio(true);

      const result = await fetchStoredContent();
      if (!result) return;

      const filename = result.filename || `audio-${requestIdNumber}.mp3`;
      const objectUrl = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
      toast.success(t('requests.actions.download'));
    } catch (_err) {
      toast.error(t('common.errors.operationFailed', { operation: t('requests.actions.downloadAudio') }));
    } finally {
      setIsLoadingAudio(false);
    }
  };

  // Load the stored audio artifact into an object URL for inline playback (TTS).
  useEffect(() => {
    if (!isSpeechRequest || !hasStoredContent) {
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;

    (async () => {
      try {
        setIsLoadingAudio(true);
        setAudioLoadFailed(false);
        const result = await fetchStoredContent();
        if (cancelled) return;
        if (!result) {
          setAudioLoadFailed(true);
          return;
        }

        createdUrl = URL.createObjectURL(result.blob);
        setAudioObjectUrl(createdUrl);
      } catch (_err) {
        // Surface the failure in the preview instead of showing "no response data".
        if (!cancelled) setAudioLoadFailed(true);
      } finally {
        if (!cancelled) setIsLoadingAudio(false);
      }
    })();

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
      setAudioObjectUrl(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSpeechRequest, hasStoredContent, request?.id]);

  const showResponseChunksModal = useCallback(() => {
    if (request?.responseChunks) {
      setSelectedResponseChunks(request.responseChunks);
      setShowResponseChunks(true);
    }
  }, [request]);

  const showExecutionChunksModal = useCallback((chunks: any[]) => {
    if (chunks && chunks.length > 0) {
      setSelectedExecutionChunks(chunks);
      setShowExecutionChunks(true);
    }
  }, []);

  const formatJson = (data: any) => {
    if (!data) return '';
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  };

  const showRequestCurlPreview = useCallback((headers: any, body: any, apiFormat?: string) => {
    const curl = generateRequestCurl(headers, body, apiFormat as any);
    setCurlCommand(curl);
    setShowCurlPreview(true);
  }, []);

  const showExecutionCurlPreview = useCallback((headers: any, body: any, channel?: { baseURL?: string; type?: string }, apiFormat?: string, requestURL?: string) => {
    const curl = generateExecutionCurl(headers, body, channel as any, apiFormat as any, requestURL);
    setCurlCommand(curl);
    setShowCurlPreview(true);
  }, []);

  const calculateLatency = (createdAt: string | Date, updatedAt: string | Date) => {
    if (!createdAt || !updatedAt) return null;
    const start = new Date(createdAt).getTime();
    const end = new Date(updatedAt).getTime();
    const diffMs = end - start;
    if (diffMs < 0) return null;
    return diffMs;
  };

  const formatLatency = (latencyMs: number | null) => {
    if (latencyMs === null) return t('requests.columns.unknown');
    if (latencyMs < 1000) return `${latencyMs}ms`;
    return `${(latencyMs / 1000).toFixed(2)}s`;
  };

  const formatCompactDate = (value: Date | string | null | undefined) =>
    value ? format(new Date(value), 'MM-dd HH.mm.ss') : t('requests.columns.unknown');

  if (isLoading) {
    return (
      <div className='flex h-full items-center justify-center py-16'>
        <div className='space-y-4 text-center'>
          <div className='border-primary mx-auto h-12 w-12 animate-spin rounded-full border-b-2'></div>
          <p className='text-muted-foreground text-lg'>{t('common.loading')}</p>
        </div>
      </div>
    );
  }

  if (!request) {
    return (
      <div className='flex h-full items-center justify-center py-16'>
        <div className='space-y-2 text-center'>
          <FileText className='text-muted-foreground mx-auto h-16 w-16' />
          <p className='text-muted-foreground text-xl font-medium'>{t('requests.dialogs.requestDetail.notFound')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className='space-y-4'>
      <Card className='gap-1 border-0 py-1 shadow-sm'>
        <CardHeader className='px-4 py-2 pb-1'>
          <CardTitle className='flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <div className='bg-primary/10 flex h-7 w-7 items-center justify-center rounded-lg'>
                <DashboardIcon className='text-primary h-3.5 w-3.5' />
              </div>
              <span className='text-base'>{t('requests.detail.overview')} / {t('requests.detail.tabs.usage')}</span>
            </div>
            <Badge className={getStatusColor(request.status)} variant='secondary'>
              {t(`requests.status.${request.status}`)}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className='px-4 pb-2'>
          <div className='flex flex-wrap items-stretch gap-2'>
        {usageLogs &&
        usageLogs.edges.length > 0 &&
        (() => {
          const usage = usageLogs.edges[0].node;
          const promptTokens = usage.promptTokens || 0;
          const cachedTokens = usage.promptCachedTokens || 0;
          const writeCachedTokens = usage.promptWriteCachedTokens || 0;
          const reasoningTokens = usage.completionReasoningTokens || 0;
          const hasReadCache = cachedTokens > 0;
          const hasWriteCache = writeCachedTokens > 0;
          const cacheHitRate = hasReadCache ? ((cachedTokens / promptTokens) * 100).toFixed(1) : '0.0';
          const writeCacheRate = hasWriteCache ? ((writeCachedTokens / promptTokens) * 100).toFixed(1) : '0.0';
          const cost = usage.totalCost ?? 0;

          const promptCost = usage.costItems?.find((i: any) => i.itemCode === 'prompt_tokens')?.subtotal;
          const completionCost = usage.costItems?.find((i: any) => i.itemCode === 'completion_tokens')?.subtotal;
          const cacheReadCost = usage.costItems?.find((i: any) => i.itemCode === 'prompt_cached_tokens')?.subtotal;
          const cacheWriteCost = usage.costItems?.find((i: any) => i.itemCode === 'prompt_write_cached_tokens')?.subtotal;

          const formatCurrency = (val: number) =>
            t('currencies.format', {
              val,
              currency: settings?.currencyCode ?? 'USD',
              locale: i18n.language === 'zh' ? 'zh-CN' : 'en-US',
              minimumFractionDigits: 6,
            });

          const renderCost = (val: number | null | undefined) => {
            if (cost <= 0) return '-';
            if (val == null || val <= 0) return '-';
            return formatCurrency(val);
          };

          return (
            <>
                  <div className='bg-muted/30 flex min-w-[145px] flex-[1_1_145px] flex-wrap items-baseline gap-x-1 rounded-md border px-2 py-1.5'>
                    <span className='text-muted-foreground text-xs font-medium'>{t('usageLogs.columns.inputLabel')}</span>
                    <span className='text-sm font-semibold'>{usage.promptTokens.toLocaleString()}</span>
                    <span className='text-muted-foreground text-xs'>{renderCost(promptCost)}</span>
                  </div>
                  <div className='bg-muted/30 flex min-w-[190px] flex-[1_1_190px] flex-wrap items-baseline gap-x-1 rounded-md border px-2 py-1.5'>
                    <span className='text-muted-foreground text-xs font-medium'>{t('usageLogs.columns.outputLabel')}</span>
                    <span className='text-sm font-semibold'>{usage.completionTokens.toLocaleString()}</span>
                    {reasoningTokens > 0 && <span className='text-muted-foreground text-xs'>/ {t('requests.columns.reasoning')}: {reasoningTokens.toLocaleString()}</span>}
                    <span className='text-muted-foreground text-xs'>{renderCost(completionCost)}</span>
                  </div>
                  <div className='bg-muted/30 flex min-w-[175px] flex-[1_1_175px] flex-wrap items-baseline gap-x-1 rounded-md border px-2 py-1.5'>
                    <span className='text-muted-foreground text-xs font-medium'>{t('usageLogs.columns.promptCachedTokens')}</span>
                    <div className='flex flex-wrap items-baseline gap-x-1'>
                        <span className='text-sm font-semibold'>{cachedTokens.toLocaleString()}</span>
                        {hasReadCache && (
                          <Badge variant='outline' className='h-4 border-green-200 bg-green-50 px-1 text-[10px] text-green-600'>
                            {cacheHitRate}%
                          </Badge>
                        )}
                        {hasWriteCache && (
                          <Badge variant='outline' className='h-4 border-blue-200 bg-blue-50 px-1 text-[10px] text-blue-600'>
                            {t('usageLogs.columns.writeCacheTokens')} {writeCacheRate}%
                          </Badge>
                        )}

                      {writeCachedTokens > 0 && (
                        <p className='text-muted-foreground text-xs'>
                          {t('requests.columns.writeCache')}: {writeCachedTokens.toLocaleString()}
                        </p>
                      )}
                      <span className='text-muted-foreground text-xs'>{renderCost(cost > 0 ? (cacheReadCost || 0) + (cacheWriteCost || 0) : null)}</span>
                    </div>
                  </div>
                  <div className='bg-muted/30 flex min-w-[145px] flex-[1_1_145px] flex-wrap items-baseline gap-x-1 rounded-md border px-2 py-1.5'>
                    <span className='text-muted-foreground text-xs font-medium'>{t('usageLogs.columns.totalTokens')}</span>
                    <span className='text-sm font-semibold'>{usage.totalTokens.toLocaleString()}</span>
                    <span className='text-muted-foreground text-xs'>{renderCost(cost)}</span>
                  </div>
            </>
          );
        })()}
          </div>
        </CardContent>
      </Card>

      <Card className='gap-0 border-0 py-0 shadow-sm'>
        <CardContent className='p-0'>
          <Tabs defaultValue='request' className='w-full'>
            <div className='bg-muted/20 border-b px-4 pt-4'>
              <TabsList className='bg-background grid w-full grid-cols-3'>
                <TabsTrigger value='request' className='data-[state=active]:bg-primary data-[state=active]:text-primary-foreground'>
                  {t('requests.detail.tabs.request')}
                </TabsTrigger>
                <TabsTrigger value='response' className='data-[state=active]:bg-primary data-[state=active]:text-primary-foreground'>
                  {t('requests.detail.tabs.response')}
                </TabsTrigger>
                <TabsTrigger value='executions' className='data-[state=active]:bg-primary data-[state=active]:text-primary-foreground'>
                  {t('requests.detail.tabs.executions')}
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value='request' className='space-y-4 p-4'>
              {request.requestHeaders && (
                <div className='space-y-4'>
                      <div className='flex items-center justify-between gap-2'>
                    <h4 className='flex items-center gap-2 text-base font-semibold'>
                      <FileText className='text-primary h-4 w-4' />
                      {t('requests.columns.requestHeaders')}
                    </h4>
                    <div className='flex shrink-0 flex-nowrap gap-2'>
                      <Button variant='outline' size='sm' onClick={() => showRequestCurlPreview(request.requestHeaders, request.requestBody, request.format)} className='hover:bg-primary hover:text-primary-foreground'>
                        <Terminal className='mr-2 h-4 w-4' />
                        {t('requests.actions.copyCurl')}
                      </Button>
                      <Button variant='outline' size='sm' onClick={() => copyToClipboard(formatJson(request.requestHeaders))} className='hover:bg-primary hover:text-primary-foreground'>
                        <Copy className='mr-2 h-4 w-4' />
                        {t('requests.dialogs.jsonViewer.copy')}
                      </Button>
                      <Button variant='outline' size='sm' onClick={() => downloadFile(formatJson(request.requestHeaders), `request-headers-${request.id}.json`)} className='hover:bg-primary hover:text-primary-foreground'>
                        <Download className='mr-2 h-4 w-4' />
                        {t('requests.dialogs.jsonViewer.download')}
                      </Button>
                    </div>
                  </div>
                  <div className='bg-muted/20 h-[300px] w-full overflow-auto rounded-lg border p-4'>
                    <JsonViewer data={request.requestHeaders} rootName='' defaultExpanded={true} expandDepth='all' hideArrayIndices={true} compactArrays={true} joinArrayValues={true} className='text-xs' />
                  </div>
                </div>
              )}
              <div className='space-y-4'>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <h4 className='flex items-center gap-2 text-base font-semibold'>
                    <FileText className='text-primary h-4 w-4' />
                    {t('requests.columns.requestBody')}
                  </h4>
                  <div className='flex flex-wrap items-center gap-2'>
                    <Tabs value={requestBodyView} onValueChange={(v: any) => setRequestBodyView(v)} className='w-auto'>
                      <TabsList className='grid w-[220px] grid-cols-2'>
                        <TabsTrigger value='conversation'>{t('requests.detail.tabs.conversation')}</TabsTrigger>
                        <TabsTrigger value='json'>{t('requests.detail.tabs.json')}</TabsTrigger>
                      </TabsList>
                    </Tabs>
                    <div className='flex gap-2'>
                      <Button variant='outline' size='sm' onClick={() => copyToClipboard(formatJson(request.requestBody))} className='hover:bg-primary hover:text-primary-foreground'>
                        <Copy className='mr-2 h-4 w-4' />
                        {t('requests.dialogs.jsonViewer.copy')}
                      </Button>
                      <Button variant='outline' size='sm' onClick={() => downloadFile(formatJson(request.requestBody), `request-body-${request.id}.json`)} className='hover:bg-primary hover:text-primary-foreground'>
                        <Download className='mr-2 h-4 w-4' />
                        {t('requests.dialogs.jsonViewer.download')}
                      </Button>
                    </div>
                  </div>
                </div>
                {requestBodyView === 'conversation' ? (
                  <RequestConversationViewer body={request.requestBody} format={request.format} />
                ) : (
                  <div className='bg-muted/20 h-[500px] w-full overflow-auto rounded-lg border p-4'>
                    <JsonViewer data={request.requestBody} rootName='' defaultExpanded={true} expandDepth='all' hideArrayIndices={true} compactArrays={true} className='text-xs' />
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value='response' className='space-y-4 p-4'>
              {responseHeaders && Object.keys(responseHeaders).length > 0 && (
                <div className='space-y-2'>
                  <div className='flex items-center justify-between'>
                    <h4 className='flex items-center gap-2 text-base font-semibold'>
                      <FileText className='text-primary h-4 w-4' />
                      {t('requests.columns.responseHeaders', '响应头')}
                    </h4>
                    <div className='flex gap-2'>
                      <Button variant='outline' size='sm' onClick={() => copyToClipboard(formatJson(responseHeaders))}>
                        <Copy className='mr-2 h-4 w-4' />
                        {t('requests.dialogs.jsonViewer.copy')}
                      </Button>
                      <Button variant='outline' size='sm' onClick={() => downloadFile(formatJson(responseHeaders), `response-headers-${request.id}.json`)}>
                        <Download className='mr-2 h-4 w-4' />
                        {t('requests.dialogs.jsonViewer.download')}
                      </Button>
                    </div>
                  </div>
                  <div className='bg-muted/20 max-h-[260px] w-full overflow-auto rounded-lg border p-3'>
                    <JsonViewer data={responseHeaders} rootName='' defaultExpanded={true} expandDepth='all' hideArrayIndices={true} compactArrays={true} joinArrayValues={true} className='text-xs' />
                  </div>
                </div>
              )}
              <Tabs value={responseView} onValueChange={(v: any) => setResponseView(v)} className='w-full'>
                <div className='flex flex-wrap items-center justify-between gap-4'>
                  <TabsList className='grid w-full grid-cols-2 sm:w-[300px]'>
                    <TabsTrigger value='preview'>{t('requests.detail.tabs.preview')}</TabsTrigger>
                    <TabsTrigger value='json'>{t('requests.detail.tabs.json')}</TabsTrigger>
                  </TabsList>

                  <div className='flex flex-wrap items-center gap-2'>
                    {isVideoRequest && hasStoredContent && (
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={downloadVideo}
                        disabled={isDownloadingVideo}
                        className='hover:bg-primary hover:text-primary-foreground'
                      >
                        <Download className='mr-2 h-4 w-4' />
                        {t('requests.actions.downloadVideo')}
                      </Button>
                    )}
                    {isSpeechRequest && hasStoredContent && (
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={downloadAudio}
                        disabled={isLoadingAudio}
                        className='hover:bg-primary hover:text-primary-foreground'
                      >
                        <Download className='mr-2 h-4 w-4' />
                        {t('requests.actions.downloadAudio')}
                      </Button>
                    )}
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={showResponseChunksModal}
                      disabled={!hasResponseChunks}
                      className='hover:bg-primary hover:text-primary-foreground disabled:opacity-50'
                    >
                      <Layers className='mr-2 h-4 w-4' />
                      {request?.stream && request?.status === 'processing'
                        ? t('requests.actions.preview')
                        : t('requests.columns.responseChunks')}
                    </Button>
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => {
                        if (responseView === 'preview') {
                          copyToClipboard(extractResponseText());
                        } else {
                          copyToClipboard(formatJson(request.responseBody));
                        }
                      }}
                      disabled={responseView === 'preview' ? !extractResponseText() : !hasResponseBody}
                      className='hover:bg-primary hover:text-primary-foreground disabled:opacity-50'
                    >
                      <Copy className='mr-2 h-4 w-4' />
                      {t('requests.dialogs.jsonViewer.copy')}
                    </Button>
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => downloadFile(formatJson(request.responseBody), `response-body-${request.id}.json`)}
                      disabled={!hasResponseBody}
                      className='hover:bg-primary hover:text-primary-foreground disabled:opacity-50'
                    >
                      <Download className='mr-2 h-4 w-4' />
                      {t('requests.dialogs.jsonViewer.download')}
                    </Button>
                  </div>
                </div>

                <div className='mt-6'>
                  <TabsContent value='preview' className='mt-0 transition-all focus-visible:outline-none'>
                    {isSpeechRequest ? (
                      <div className='bg-muted/20 flex min-h-[200px] w-full flex-col items-center justify-center gap-4 rounded-lg border p-6'>
                        {audioObjectUrl ? (
                          <audio controls src={audioObjectUrl} className='w-full max-w-xl'>
                            {t('requests.detail.audioNotSupported')}
                          </audio>
                        ) : isLoadingAudio ? (
                          <div className='space-y-4 text-center'>
                            <div className='border-primary mx-auto h-8 w-8 animate-spin rounded-full border-b-2'></div>
                            <p className='text-muted-foreground text-sm'>{t('common.loading')}...</p>
                          </div>
                        ) : (
                          <div className='space-y-3 text-center'>
                            <FileText className='text-muted-foreground mx-auto h-12 w-12' />
                            <p className='text-muted-foreground text-base'>
                              {audioLoadFailed
                                ? t('requests.detail.audioLoadFailed')
                                : hasStoredContent
                                  ? t('requests.detail.noResponse')
                                  : t('requests.detail.audioNotStored')}
                            </p>
                          </div>
                        )}
                      </div>
                    ) : hasPreviewData || isLive ? (
                      <ResponseFlow
                        chunks={request.responseChunks}
                        body={request.responseBody}
                        isLive={isLive}
                        reasoningDurationMs={request.metricsReasoningDurationMs}
                      />
                    ) : request.status === 'processing' ? (
                      <div className='bg-muted/20 flex h-[400px] w-full items-center justify-center rounded-lg border'>
                        <div className='space-y-4 text-center'>
                          <div className='border-primary mx-auto h-8 w-8 animate-spin rounded-full border-b-2'></div>
                          <p className='text-muted-foreground text-sm'>{t('common.loading')}...</p>
                        </div>
                      </div>
                    ) : (
                      <div className='bg-muted/20 flex h-[400px] w-full items-center justify-center rounded-lg border'>
                        <div className='space-y-3 text-center'>
                          <FileText className='text-muted-foreground mx-auto h-12 w-12' />
                          <p className='text-muted-foreground text-base'>{t('requests.detail.noResponse')}</p>
                        </div>
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value='json' className='mt-0 focus-visible:outline-none'>
                    {hasResponseBody ? (
                      <div className='bg-muted/20 h-[500px] w-full overflow-auto rounded-lg border p-4'>
                        <JsonViewer data={request.responseBody} rootName='' defaultExpanded={true} expandDepth='all' hideArrayIndices={true} compactArrays={true} className='text-xs' />
                      </div>
                    ) : request.status === 'processing' ? (
                      <div className='bg-muted/20 flex h-[500px] w-full items-center justify-center rounded-lg border'>
                        <div className='space-y-4 text-center'>
                          <div className='border-primary mx-auto h-8 w-8 animate-spin rounded-full border-b-2'></div>
                          <p className='text-muted-foreground text-sm'>{t('common.loading')}...</p>
                        </div>
                      </div>
                    ) : (
                      <div className='bg-muted/20 flex h-[500px] w-full items-center justify-center rounded-lg border'>
                        <div className='space-y-3 text-center'>
                          <FileText className='text-muted-foreground mx-auto h-12 w-12' />
                          <p className='text-muted-foreground text-base'>{t('requests.detail.noResponse')}</p>
                        </div>
                      </div>
                    )}
                  </TabsContent>
                </div>
              </Tabs>
            </TabsContent>

            <TabsContent value='executions' className='space-y-4 p-4'>
              {isExecutionsLoading ? (
                <div className='py-16 text-center'>
                  <div className='space-y-4'>
                    <div className='border-primary mx-auto h-12 w-12 animate-spin rounded-full border-b-2'></div>
                    <p className='text-muted-foreground text-lg'>{t('common.loading')}</p>
                  </div>
                </div>
              ) : isExecutionsError ? (
                <div className='py-16 text-center'>
                  <div className='space-y-4'>
                    <FileText className='text-muted-foreground mx-auto h-16 w-16' />
                    <p className='text-muted-foreground text-lg'>{t('common.errors.internalServerError')}</p>
                  </div>
                </div>
              ) : executions && executions.edges.length > 0 ? (
                <div className='space-y-3'>
                  {executions.edges.map((edge: any, index: number) => {
                    const execution = edge.node;
                    return (
                      <Card key={execution.id} className='bg-muted/20 gap-1 border-0 py-1 shadow-sm'>
                        <CardHeader className='px-4 py-2'>
                          <div className='flex items-center justify-between'>
                            <h5 className='flex items-center gap-2 text-base font-semibold'>
                              <div className='bg-primary/10 text-primary flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold'>
                                {index + 1}
                              </div>
                              {t('requests.dialogs.requestDetail.execution', { index: index + 1 })}
                            </h5>
                            <Badge className={getStatusColor(execution.status)} variant='secondary'>
                              {t(`requests.status.${execution.status}`)}
                            </Badge>
                            {execution.passThroughApplied && (
                              <Badge className='border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300'>
                                {t('requests.passThrough.applied')}
                              </Badge>
                            )}
                          </div>
                        </CardHeader>
                        <CardContent className='space-y-3 px-4 pb-2'>
                          <div className='flex flex-wrap items-stretch gap-2'>
                            <div className='bg-background flex min-w-[130px] flex-[1_1_130px] items-center gap-1.5 rounded-md border px-2 py-1.5'>
                              <span className='flex w-[58px] shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium'>
                                <Database className='text-primary h-3.5 w-3.5' />
                                {t('requests.columns.channel')}:
                              </span>
                              <p className='text-muted-foreground min-w-0 flex-1 truncate text-left font-mono text-xs'>
                                {execution.channel?.name || t('requests.columns.unknown')}
                              </p>
                            </div>
                            <div className='bg-background flex min-w-[175px] flex-[1.3_1_175px] items-center gap-1.5 rounded-md border px-2 py-1.5'>
                              <span className='flex w-[78px] shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium'>
                                <Clock className='text-primary h-3.5 w-3.5' />
                                {t('requests.dialogs.requestDetail.fields.startTime')}:
                              </span>
                              <p className='text-muted-foreground min-w-0 flex-1 whitespace-nowrap text-left font-mono text-xs'>
                                {formatCompactDate(execution.createdAt)}
                              </p>
                            </div>
                            <div className='bg-background flex min-w-[175px] flex-[1.3_1_175px] items-center gap-1.5 rounded-md border px-2 py-1.5'>
                              <span className='flex w-[78px] shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium'>
                                <Clock className='text-primary h-3.5 w-3.5' />
                                {t('requests.dialogs.requestDetail.fields.endTime')}:
                              </span>
                              <p className='text-muted-foreground min-w-0 flex-1 whitespace-nowrap text-left font-mono text-xs'>
                                {execution.status === 'completed' || execution.status === 'failed'
                                  ? execution.updatedAt
                                    ? formatCompactDate(execution.updatedAt)
                                    : t('requests.columns.unknown')
                                  : '-'}
                              </p>
                            </div>
                            <div className='bg-background flex min-w-[115px] flex-[0.8_1_115px] items-center gap-1.5 rounded-md border px-2 py-1.5'>
                              <span className='flex w-[48px] shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium'>
                                <Clock className='text-primary h-3.5 w-3.5' />
                                {t('requests.columns.latency')}:
                              </span>
                              <p className='text-muted-foreground min-w-0 flex-1 whitespace-nowrap text-left font-mono text-xs'>
                                {execution.status === 'completed' || execution.status === 'failed' ? formatLatency(calculateLatency(execution.createdAt, execution.updatedAt)) : '-'}
                              </p>
                            </div>
                            <div className='bg-background flex min-w-[125px] flex-[0.9_1_125px] items-center gap-1.5 rounded-md border px-2 py-1.5'>
                              <span className='flex w-[68px] shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium'>
                                <Clock className='text-primary h-3.5 w-3.5' />
                                {t('requests.columns.firstTokenLatency')}:
                              </span>
                              <p className='text-muted-foreground min-w-0 flex-1 whitespace-nowrap text-left font-mono text-xs'>
                                {execution.status === 'completed' && execution.metricsFirstTokenLatencyMs != null ? formatLatency(execution.metricsFirstTokenLatencyMs) : '-'}
                              </p>
                            </div>
                          </div>

                          {(execution.errorMessage || (execution.status === 'failed' && execution.responseStatusCode)) && (
                            <div className='bg-destructive/5 border-destructive/20 space-y-3 rounded-lg border p-4'>
                              <div className='flex items-center justify-between'>
                                <span className='text-destructive flex items-center gap-2 text-sm font-semibold'>
                                  <FileText className='h-4 w-4' />
                                  {t('common.messages.errorMessage')}
                                </span>
                                {execution.status === 'failed' && execution.responseStatusCode && <Badge variant='destructive'>{execution.responseStatusCode}</Badge>}
                              </div>
                              {execution.errorMessage && <p className='text-destructive bg-destructive/10 rounded border p-3 text-sm'>{execution.errorMessage}</p>}
                            </div>
                          )}

                          {execution.requestHeaders && (
                            <div className='space-y-3'>
                              <div className='flex items-center justify-between'>
                                <span className='flex items-center gap-2 text-sm font-semibold'>
                                  <FileText className='text-primary h-4 w-4' />
                                  {t('requests.columns.requestHeaders')}
                                </span>
                                <div className='flex shrink-0 flex-nowrap gap-2'>
                                  <Button variant='outline' size='sm' onClick={() => showExecutionCurlPreview(execution.requestHeaders, execution.requestBody, execution.channel, execution.format, execution.requestURL)} className='hover:bg-primary hover:text-primary-foreground'>
                                    <Terminal className='mr-2 h-4 w-4' />
                                    {t('requests.actions.copyCurl')}
                                  </Button>
                                  <Button variant='outline' size='sm' onClick={() => copyToClipboard(formatJson(execution.requestHeaders))} className='hover:bg-primary hover:text-primary-foreground'>
                                    <Copy className='mr-2 h-4 w-4' />
                                    {t('requests.dialogs.jsonViewer.copy')}
                                  </Button>
                                  <Button variant='outline' size='sm' onClick={() => downloadFile(formatJson(execution.requestHeaders), `execution-${execution.id}-request-headers.json`)} className='hover:bg-primary hover:text-primary-foreground'>
                                    <Download className='mr-2 h-4 w-4' />
                                    {t('requests.dialogs.jsonViewer.download')}
                                  </Button>
                                </div>
                              </div>
                              <div className='bg-background h-64 w-full overflow-auto rounded-lg border p-3'>
                                <JsonViewer data={execution.requestHeaders} rootName='' defaultExpanded={false} hideArrayIndices={true} compactArrays={true} joinArrayValues={true} className='text-xs' />
                              </div>
                            </div>
                          )}

                          {execution.requestBody && (
                            <div className='space-y-3'>
                              <div className='flex items-center justify-between'>
                                <span className='flex items-center gap-2 text-sm font-semibold'>
                                  <FileText className='text-primary h-4 w-4' />
                                  {t('requests.columns.requestBody')}
                                </span>
                                <div className='flex gap-2'>
                                  <Button variant='outline' size='sm' onClick={() => copyToClipboard(formatJson(execution.requestBody))} className='hover:bg-primary hover:text-primary-foreground'>
                                    <Copy className='mr-2 h-4 w-4' />
                                    {t('requests.dialogs.jsonViewer.copy')}
                                  </Button>
                                  <Button variant='outline' size='sm' onClick={() => downloadFile(formatJson(execution.requestBody), `execution-${execution.id}-request-body.json`)} className='hover:bg-primary hover:text-primary-foreground'>
                                    <Download className='mr-2 h-4 w-4' />
                                    {t('requests.dialogs.jsonViewer.download')}
                                  </Button>
                                </div>
                              </div>
                              <div className='bg-background h-80 w-full overflow-auto rounded-lg border p-3'>
                                <JsonViewer data={execution.requestBody} rootName='' defaultExpanded={false} hideArrayIndices={true} compactArrays={true} className='text-xs' />
                              </div>
                            </div>
                          )}

                          {execution.responseBody && (
                            <div className='space-y-3'>
                              <div className='flex items-center justify-between'>
                                <span className='flex items-center gap-2 text-sm font-semibold'>
                                  <FileText className='text-primary h-4 w-4' />
                                  {t('requests.columns.responseBody')}
                                </span>
                                <div className='flex gap-2'>
                                  <Button variant='outline' size='sm' onClick={() => copyToClipboard(formatJson(execution.responseBody))} className='hover:bg-primary hover:text-primary-foreground'>
                                    <Copy className='mr-2 h-4 w-4' />
                                    {t('requests.dialogs.jsonViewer.copy')}
                                  </Button>
                                  <Button variant='outline' size='sm' onClick={() => downloadFile(formatJson(execution.responseBody), `execution-${execution.id}-response-body.json`)} className='hover:bg-primary hover:text-primary-foreground'>
                                    <Download className='mr-2 h-4 w-4' />
                                    {t('requests.dialogs.jsonViewer.download')}
                                  </Button>
                                  <Button variant='outline' size='sm' onClick={() => showExecutionChunksModal(execution.responseChunks || [])} disabled={!execution.responseChunks || execution.responseChunks.length === 0} className='hover:bg-primary hover:text-primary-foreground'>
                                    <Layers className='mr-2 h-4 w-4' />
                                    {t('requests.columns.responseChunks')}
                                  </Button>
                                </div>
                              </div>
                              <div className='bg-background h-80 w-full overflow-auto rounded-lg border p-3'>
                                <JsonViewer data={execution.responseBody} rootName='' defaultExpanded={false} hideArrayIndices={true} compactArrays={true} className='text-xs' />
                              </div>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              ) : (
                <div className='py-16 text-center'>
                  <div className='space-y-4'>
                    <FileText className='text-muted-foreground mx-auto h-16 w-16' />
                    <p className='text-muted-foreground text-lg'>{t('requests.dialogs.requestDetail.noExecutions')}</p>
                  </div>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <ChunksDialog
        open={showResponseChunks}
        onOpenChange={setShowResponseChunks}
        chunks={request?.responseChunks ?? []}
        isLive={request?.stream === true && request?.status === 'processing'}
        title={t('requests.dialogs.jsonViewer.responseChunks')}
      />
      <ChunksDialog
        open={showExecutionChunks}
        onOpenChange={setShowExecutionChunks}
        chunks={selectedExecutionChunks}
        title={t('requests.dialogs.jsonViewer.responseChunks')}
      />
      <CurlPreviewDialog open={showCurlPreview} onOpenChange={setShowCurlPreview} curlCommand={curlCommand} />
    </div>
  );
}
