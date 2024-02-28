import { initialize } from '../workerTemplate.js';
import logger from './child-logger.js';
import path from 'path';
import * as fs from 'fs';

import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import utc from 'dayjs/plugin/utc.js';
import { getClient } from './get-client.js';
dayjs.extend(customParseFormat);
dayjs.extend(utc);

const workerQueue = process.env.WORKERQUEUE;
const resultQueue = process.env.RESULTSQUEUE;
const rabbitHost = process.env.RABBITHOST;
const rabbitUser = process.env.RABBITUSER;
const rabbitPass = process.env.RABBITPASS;

const archiveWorker = async (workerJob, inputs) => {
    const inputPath = inputs[0];
    const finalDatadir = inputs[1];
    const dirToArchive = `${finalDatadir}/archive`;
    const inputFilename = path.basename(inputPath);
    // get region and timestamp from input (example format: langenfeld_20230629T0500Z.tif)
    const regex = /^([^_]+)_(\d{8}T\d{4}Z)/;
    const matches = inputFilename.match(regex);
    const region = matches[1];
    // timestamp in filename is in UTC time, round to last hour
    const datasetTimestamp = dayjs.utc(matches[2], 'YYYYMMDDTHHmmZ').startOf('hour');
    if (!datasetTimestamp.isValid()) {
        // timestamp of dataset not valid
        logger.error('Could not parse dataset timestamp.');
        throw 'Could not parse dataset timestamp.';
    }
    // get timestamp for current hour
    const currentTimestamp = dayjs.utc().startOf('hour');

    const copyToArchiveDir = async () => {
        // check if incomimg dataset timestamp === current timestamp and create file name to archive
        if (datasetTimestamp.isSame(currentTimestamp)) {
            const fileToArchive = `${region}_${datasetTimestamp.format('YYYYMMDDTHHmm')}Z.tif`;
            // create directory to archive to
            let canAccess;
            try {
                await fs.access(dirToArchive);
                canAccess = true;
            } catch (error) {
                logger.warn('Error');
                canAccess = false;
            }
            if (!canAccess) {
                await fs.mkdir(dirToArchive);
                logger.info(`New archive directory created`);
            }
            await fs.copyFile(
                `${finalDatadir}/${region}/${region}_temperature/${fileToArchive}`,
                `${dirToArchive}/${fileToArchive}`
            );
        }
    };

    // clean up files that are older than 49 hours
    const datatype = [
        {
            name: '_temperature',
            timecol: 'time',
            directoryPath: `${finalDatadir}/${region}/${region}_temperature/`
        },
        {
            name: '_reclassified',
            timecol: 'time',
            directoryPath: `${finalDatadir}/${region}/${region}_reclassified/`
        },
        {
            name: '_contourlines',
            timecol: 'timestamp'
        }
    ]

    const cleanUpFiles = async (directoryPath) => {
        logger.info('File cleanup started');
        // 1. get all timestamps in directory
        const files = fs.readdirSync(directoryPath);
        const timestamps = files.map((element) => dayjs.utc(element.match(regex)[2], 'YYYYMMDDTHHmmZ').startOf('hour'));
        // 2. get timestamps that are older than 49 hours
        const timestampsToDelete = timestamps.filter(timestamp => timestamp < currentTimestamp.subtract(49, 'hours'));
        // 3. create list of files to delete

        const fileNamesToDelete = [];
        for (const timestamp of timestampsToDelete) {
            const fileToDelete = files.filter(file => file.includes(timestamp.format('YYYYMMDDTHH')));
            if (fileToDelete) {
                fileNamesToDelete.push(fileToDelete);
            } else {
                continue
            }
        }

        const filesToDelete = fileNamesToDelete.map((fileName) => `${directoryPath}${fileName}`);

        for (const file of filesToDelete) {

            await fs.unlink(file, (err => {
                if (err) logger.error(err);
                else {
                    logger.info('Deleted file:', file)
                }
            }));
        }
    };

    // Clean up databse tables
    const cleanUpDb = async (datatype) => {
        logger.info('Database cleanup started');
        const timestamp = currentTimestamp.subtract(49, 'hours').format('YYYY-MM-DD HH:mm:ss');

        let client;
        try {
            // connect to database
            client = await getClient();
            // delete rows older than 49 hours
            const cleanUpQuery = `DELETE FROM ${region}${datatype.name} WHERE ${datatype.timecol} < '${timestamp}';`;
            await client.query(cleanUpQuery);
            logger.info(`Cleaned up table.`);
        } catch (e) {
            logger.error('SQL execution aborted:' + e);
        } finally {
            if (client) {
                await client.end();
            }
        }
    }

    try {
        await copyToArchiveDir();
        for (const type of datatype) {
            if (type.directoryPath) {
                await cleanUpFiles(type.directoryPath);
              }
            await cleanUpDb(type);
        }
    } catch (error) {
        logger.error(`Could not copy dataset with timestamp: ${datasetTimestamp}.`);
    }

    workerJob.status = 'success';

    logger.info(`Archiving finished.`);
};

(async () => {
    try {
        // Initialize and start the worker process
        await initialize(rabbitHost, rabbitUser, rabbitPass, workerQueue, resultQueue, archiveWorker);
    } catch (error) {
        logger.error({ error: error }, `Problem when initializing`);
    }
})();
export default archiveWorker;
