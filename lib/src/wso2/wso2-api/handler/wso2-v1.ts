/* eslint-disable no-console */
import { OpenAPIObject } from 'openapi3-ts/oas30';
import { oas30 } from 'openapi3-ts';
import axios, { AxiosError, AxiosInstance } from 'axios';
import FormData from 'form-data';
import { backOff } from 'exponential-backoff';

import {
  Wso2ApimConfig,
  checkWso2ServerVersion,
  getBearerToken,
  registerClient,
} from '../../wso2-utils';
import { RetryOptions, Wso2Config } from '../types';
import {
  ApiFromListV1,
  DevPortalAPIv1,
  PublisherPortalAPIv1,
  Wso2ApiDefinitionV1,
  Wso2ApiListV1,
} from '../v1/types';

import { areAttributeNamesEqual, getSecretValue } from './utils';

export const prepareAxiosForWso2Api = async (wso2Config: Wso2Config): Promise<AxiosInstance> => {
  // get wso2 user/pass
  const creds = await getSecretValue(wso2Config.credentialsSecretId);
  let wso2Creds;
  try {
    wso2Creds = JSON.parse(creds);
  } catch (err) {
    throw new Error(
      `Couldn't parse credentials from secret manager at ${wso2Config.credentialsSecretId}. Check if it's a json with attributes {'user':'someuser', 'pwd':'mypass'}. err=${err}`,
    );
  }
  if (!wso2Creds.user || !wso2Creds.pwd) {
    throw new Error(
      `'user' and 'pwd' attributes from credentials  ${wso2Config.credentialsSecretId} are required`,
    );
  }

  // prepare wso2 api client
  let username = wso2Creds.user;
  if (wso2Config.tenant) {
    username = `${wso2Creds.user}@${wso2Config.tenant}`;
  }

  const wso2ApimConfig: Wso2ApimConfig = {
    baseUrl: wso2Config.baseApiUrl,
    username,
    password: wso2Creds.pwd,
    clientName: 'cdk-practical-constructs-wso2',
  };

  const clientCredentials = await registerClient(wso2ApimConfig);
  const accessToken = await getBearerToken(wso2ApimConfig, clientCredentials);

  await checkWso2ServerVersion(wso2ApimConfig, 'v1');

  const client = axios.create({
    baseURL: wso2Config.baseApiUrl,
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client.interceptors.request.use((config: any) => {
    // eslint-disable-next-line no-param-reassign
    config.metadata = { startTime: new Date().getTime() };
    console.log(`> REQUEST: ${config.method?.toUpperCase()} ${wso2Config.baseApiUrl}${config.url}`);
    console.log(
      JSON.stringify({
        baseURL: config.baseURL,
        url: config.url,
        params: config.params,
        method: config.method,
        headers: config.headers,
        status: config.status,
        data: config.data,
      }),
    );
    return config;
  });

  client.interceptors.response.use(
    (response) => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const elapsedTime = new Date().getTime() - response.config.metadata.startTime;
      console.log(`> RESPONSE: ${response.status} (${elapsedTime}ms)`);
      console.log(
        JSON.stringify({
          status: response.status,
          headers: response.headers,
          data: response.data,
        }),
      );
      return response;
    },
    // eslint-disable-next-line promise/prefer-await-to-callbacks
    (error: Error | AxiosError) => {
      if (axios.isAxiosError(error)) {
        console.log(`RESPONSE ERROR: status=${error.response?.status}`);
        console.log(
          JSON.stringify({
            status: error.response?.status,
            headers: error.response?.headers,
            data: error.response?.data,
          }),
        );
      }
      throw error;
    },
  );

  return client;
};

export const findWso2Api = async (args: {
  wso2Axios: AxiosInstance;
  apiDefinition: Wso2ApiDefinitionV1;
  wso2Tenant: string;
}): Promise<ApiFromListV1 | undefined> => {
  const searchQuery = `name:${args.apiDefinition.name} version:${args.apiDefinition.version} context:${args.apiDefinition.context}`;

  const res = await args.wso2Axios.get(`/api/am/publisher/v1/apis`, {
    params: { query: searchQuery },
  });

  const apilist = res.data as Wso2ApiListV1;

  if (!apilist.list) {
    throw new Error('apilist.list should exist even if empty');
  }

  // no api found with query parameters
  if (apilist.list.length === 0) {
    console.log(`No APIs were returned from WSO2 list with query='${searchQuery}'`);
    // eslint-disable-next-line no-undefined
    return undefined;
  }

  // filter out apis that were found but don't match our tenant
  const filteredApis = apilist.list.filter((api) => {
    if (api.name !== args.apiDefinition.name || api.version !== args.apiDefinition.version) {
      return false;
    }
    if (!api.context) return false;
    // 'api.context' may contain the full context name in wso2, which means '/t/[tenant]/[api context]'
    if (api.context.endsWith(args.apiDefinition.context)) {
      if (args.wso2Tenant) {
        return api.context.startsWith(`/t/${args.wso2Tenant}`);
      }
      // when we don't have tenants, there is no /t/[tenant] prefix
      return true;
    }
    // context doesn't match
    return false;
  });

  if (filteredApis.length === 1) {
    return filteredApis[0];
  }
  if (filteredApis.length === 0) {
    // eslint-disable-next-line no-undefined
    return undefined;
  }
  throw new Error(
    `Cannot determine which WSO2 API is related to this Custom Resource. More than 1 API with search query '${searchQuery}' matches. name=${args.apiDefinition.name} context=${args.apiDefinition.context} version=${args.apiDefinition.version} tenant=${args.wso2Tenant}`,
  );
};

export type UpsertWso2Args = {
  wso2Axios: AxiosInstance;
  wso2Tenant: string;
  apiBeforeUpdate?: {
    id?: string;
    lastUpdatedTime?: string;
  };
  apiDefinition: Wso2ApiDefinitionV1;
  openapiDocument: OpenAPIObject;
  retryOptions: RetryOptions;
};

/**
 * Delete API in WSO2 server
 */
export const removeApiInWso2 = async (args: {
  wso2Axios: AxiosInstance;
  wso2ApiId: string;
}): Promise<void> => {
  if (!args.wso2ApiId) {
    throw new Error('wso2ApiId is required for deleting API');
  }
  await args.wso2Axios.delete(`/api/am/publisher/v1/apis/${args.wso2ApiId}`);
};

/**
 * Perform calls in WSO2 API to create or update an API, update Openapi definitions
 * and change the API lifecycle to PUBLISHED
 * @returns {string} Id of the API in WSO2
 */
export const createUpdateAndPublishApiInWso2 = async (
  args: UpsertWso2Args,
): Promise<{ wso2ApiId: string; endpointUrl?: string }> => {
  // TODO add retry witth backoff for all these operations

  console.log('');
  console.log(`>>> Create or update api in WSO2...`);
  // will retry create/update api operation if fails
  const wso2ApiId = await backOff(
    async () => createUpdateApiInWso2AndCheck(args),
    args.retryOptions.mutationRetries,
  );

  console.log('');
  console.log(`>>> Update Openapi definitions in WSO2 (Swagger)...`);
  // will retry publishing openapi if fails
  await backOff(
    async () =>
      updateOpenapiInWso2AndCheck({
        ...args,
        wso2ApiId,
      }),
    args.retryOptions.mutationRetries,
  );

  console.log('');
  console.log(`>>> Change api status to 'PUBLISHED'...`);
  // will retry changing to PUBLISHED if fails
  const endpointUrl = await backOff(async () =>
    publishApiInWso2AndCheck({
      wso2Axios: args.wso2Axios,
      wso2ApiId,
      apiDefinition: args.apiDefinition,
      wso2Tenant: args.wso2Tenant,
      retryOptions: args.retryOptions,
    }),
  );

  console.log('API created/updated and published succesfully on WSO2 server');

  return { wso2ApiId, endpointUrl };
};

export const publishApiInWso2AndCheck = async (args: {
  wso2Axios: AxiosInstance;
  apiDefinition: Wso2ApiDefinitionV1;
  wso2ApiId: string;
  wso2Tenant: string;
  retryOptions: RetryOptions;
}): Promise<string | undefined> => {
  console.log(`Changing API status to PUBLISHED in WSO2`);
  await args.wso2Axios.post(
    '/api/am/publisher/v1/apis/change-lifecycle',
    {},
    {
      params: {
        apiId: args.wso2ApiId,
        action: 'Publish',
      },
    },
  );

  // wait for API to be created by retrying checks
  await backOff(async () => {
    console.log('');
    console.log('Checking if API is PUBLISHED...');
    const fapi = await findWso2Api({
      apiDefinition: args.apiDefinition,
      wso2Axios: args.wso2Axios,
      wso2Tenant: args.wso2Tenant,
    });

    if (!fapi) {
      throw new Error(`API ${args.wso2ApiId} could not be found`);
    }
    if (fapi.lifeCycleStatus !== 'PUBLISHED') {
      throw new Error(`API ${args.wso2ApiId} is in status ${fapi.lifeCycleStatus} (not PUBLISHED)`);
    }
    console.log('API status PUBLISHED check OK');
  }, args.retryOptions.checkRetries);

  // get endpoint url
  console.log(`Getting API endpoint url`);
  const apir = await args.wso2Axios.get(`/api/am/store/v1/apis/${args.wso2ApiId}`);

  // find the endpoint URL of the environment that was defined in this API
  const apid = apir.data as DevPortalAPIv1;
  const endpointUrl = apid.endpointURLs?.reduce((acc, elem) => {
    if (
      elem.environmentName &&
      args.apiDefinition.gatewayEnvironments?.includes(elem.environmentName)
    ) {
      if (elem.URLs?.https) {
        return elem.URLs?.https;
      }
      if (elem.defaultVersionURLs?.https) {
        return elem.defaultVersionURLs?.https;
      }
    }
    return acc;
  }, '');

  return endpointUrl;
};

export const updateOpenapiInWso2AndCheck = async (args: {
  wso2Axios: AxiosInstance;
  wso2ApiId: string;
  wso2Tenant: string;
  openapiDocument: oas30.OpenAPIObject;
  apiDefinition: Wso2ApiDefinitionV1;
  retryOptions: RetryOptions;
}): Promise<void> => {
  console.log('Updating Openapi document in WSO2');
  const fdata = new FormData();
  const openapiDocumentStr = JSON.stringify(args.openapiDocument);
  fdata.append('apiDefinition', openapiDocumentStr);
  await args.wso2Axios.put(`/api/am/publisher/v1/apis/${args.wso2ApiId}/swagger`, fdata, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });

  await backOff(async () => {
    console.log('');
    console.log('Checking if Openapi was updated on WSO2...');
    const res = await args.wso2Axios.get(`/api/am/publisher/v1/apis/${args.wso2ApiId}/swagger`, {
      responseType: 'text',
      transformResponse: [(v): typeof v => v],
    });
    const openapiFromWso2Str = res.data as string;

    // The document returned by WSO2 have differences introduced by WSO2 itself
    // so we can't do a strict check. Check for a few things in the document to check sanity
    const openapiFromWso2 = JSON.parse(openapiFromWso2Str) as oas30.OpenAPIObject;

    if (!openapiSimilarWso2(openapiFromWso2, args.openapiDocument)) {
      console.log(
        `Openapi doc downloaded from WSO2 doesn't match submitted definition. EXPECTED='${openapiDocumentStr}'\nACTUAL='${openapiFromWso2Str}`,
      );
      throw new Error(`Openapi doc downloaded from WSO2 doesn't match submitted definition`);
    }
    console.log('API Openapi document check OK');
  }, args.retryOptions.checkRetries);
};

export const createUpdateApiInWso2AndCheck = async (args: UpsertWso2Args): Promise<string> => {
  // create new API in WSO2
  if (!args.apiBeforeUpdate) {
    console.log(`Creating new API in WSO2`);
    const apir = await args.wso2Axios.post(
      `/api/am/publisher/v1/apis?openAPIVersion=V3`,
      args.apiDefinition,
    );

    const dataRes = apir.data as PublisherPortalAPIv1;
    if (!dataRes.id) {
      throw new Error(`'api' id wasn't returned as part of the API creation response`);
    }
    console.log(`API created in WSO2`);

    // wait for API to be created by retrying checks
    await backOff(async () => checkApiExistsAndMatches(args), args.retryOptions.checkRetries);
    return dataRes.id;
  }

  // update existing API in WSO2
  console.log(`Updating API definitions in WSO2`);
  const res = await args.wso2Axios.put(
    `/api/am/publisher/v1/apis/${args.apiBeforeUpdate.id}`,
    args.apiDefinition,
  );
  const dataRes = res.data as PublisherPortalAPIv1;
  if (!dataRes.id) throw new Error(`'api' id wasn't returned as part of the API creation response`);

  // wait for API to be created by retrying checks
  await backOff(async () => checkApiExistsAndMatches(args), args.retryOptions.checkRetries);
  return dataRes.id;
};

/**
 * Check if api was created succesfully and if it is the same as we sent.
 * Sometimes WSO2 have some issue with cluster synchronisation and we want to
 * be sure sure that this is not happening
 * An exception will be thrown if the API doesn't exist or if its contents
 * are different
 */
const checkApiExistsAndMatches = async (
  args: Pick<UpsertWso2Args, 'apiDefinition' | 'wso2Axios' | 'wso2Tenant' | 'apiBeforeUpdate'>,
): Promise<void> => {
  // TODO check if the returned contents won't come with default values and things that doesn't actually indicates a real issue but makes it doesnt match
  console.log('');
  console.log('Checking if API exists and matches the desired definition in WSO2...');
  const searchApi = await findWso2Api({
    apiDefinition: args.apiDefinition,
    wso2Axios: args.wso2Axios,
    wso2Tenant: args.wso2Tenant,
  });

  if (!searchApi) {
    throw new Error(`API couldn't be found on WSO2`);
  }

  console.log(`API '${searchApi.id}' found in WSO2 search`);

  const apir = await args.wso2Axios.get(`/api/am/publisher/v1/apis/${searchApi.id}`);
  const apiDetails = apir.data as PublisherPortalAPIv1;

  if (!apiDetails.lastUpdatedTime) {
    throw new Error('lastUpdatedTime is null in api');
  }

  if (
    apiDetails.name !== searchApi.name ||
    apiDetails.context !== searchApi.context ||
    apiDetails.version !== searchApi.version ||
    apiDetails.lifeCycleStatus !== searchApi.lifeCycleStatus
  ) {
    throw new Error(
      `Some contents from the search API results are different from the ones fetched in /api/{id}. 
      ${JSON.stringify(apiDetails)} -- ${JSON.stringify(searchApi)}`,
    );
  }

  if (!args.apiBeforeUpdate) {
    console.log(`API '${searchApi.id}' check OK`);
    return;
  }

  // This is an update. Check if timestamp has changed
  if (!args.apiBeforeUpdate.lastUpdatedTime) {
    throw new Error('lastUpdatedTime is null in api before updated');
  }
  if (apiDetails.lastUpdatedTime <= args.apiBeforeUpdate.lastUpdatedTime) {
    throw new Error(`API 'lastUpdatedTime' has not changed after updating the API definitions yet`);
  }

  console.log(`API '${searchApi.id}' check OK`);
};

/**
 * Verifies if openapi spec sent and downloaded from Wso2 seems the same
 * WSO2 adds attributes to the original Openapi spec, so we have to do
 * an best effort to do this check
 */
export const openapiSimilarWso2 = (
  subOpenapi: oas30.OpenAPIObject,
  wso2Openapi: oas30.OpenAPIObject,
): boolean => {
  if (
    subOpenapi.info.title !== wso2Openapi.info.title ||
    subOpenapi.paths.length !== wso2Openapi.paths.length ||
    subOpenapi.servers?.length !== wso2Openapi.servers?.length ||
    !areAttributeNamesEqual(subOpenapi.components?.schemas, wso2Openapi.components?.schemas) ||
    !areAttributeNamesEqual(subOpenapi.paths, wso2Openapi.paths) ||
    subOpenapi.openapi !== wso2Openapi.openapi
  ) {
    return false;
  }
  return true;
};
