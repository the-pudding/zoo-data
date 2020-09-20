/* eslint-disable no-console */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */

// process.env.DEBUG='pw:api'

const { firefox } = require('playwright-firefox');
const GIFEncoder = require('gif-encoder-2')
const {createCanvas, Image} = require('canvas')
const fs = require('fs')
const AWS = require('aws-sdk')
const d3 = require('d3-dsv');

const filePathImages = 'zoo-cams/stills'
const filePathGIF = 'zoo-cams/output'
const frameCount = 15
const frameRange = [...Array(frameCount).keys()]

const {AWS_KEY, AWS_KEY_SECRET, AWS_BUCKET} = process.env

AWS.config.update({
	maxRetries: 2,
	httpOptions: {
		timeout: 30000,
		connectTimeout: 5000
	}
})

const s3Bucket = new AWS.S3({
	accessKeyId: AWS_KEY,
	secretAccessKey: AWS_KEY_SECRET,
	region: 'us-east-1',
	params: {
		Bucket: AWS_BUCKET
	}
})

const webcams = d3.csvParse(fs.readFileSync('zoos.csv', 'utf-8'))

async function checkPlayButtons(page, play){
	const buttons = play.split(', ')
	for (const btn of buttons){
		await page.click(`${btn}`, {timeout: 10000}).catch(e => `Oops can't click: ${e}`)
	}
}

async function findVideo(page, cam){
	const {url, id, play} = cam
	console.log(`Preparing ${id} for screenshot`)

	// setup page
	await page.setDefaultTimeout(20000)
	await page.setViewportSize({ width: 640, height: 480 })
	page.on('crash', error => {throw new Error(`Page crashed: ${error}`)})

	// navigate to page
	await page.goto(url)
        
	// if there are play buttons, click them
	if (play) await checkPlayButtons(page, play).catch(error => console.error(`Error clicking play buttons: ${error}`))

	// get video element playing
	await page.waitForTimeout(4000)
	await page.$$('video', el => el.play())
	if (play) await page.waitForTimeout(20000)
	else await page.waitForTimeout(2000)

	return await page.$('video')
}

async function saveToS3(ss, videoDimensions, id, ext){
	return new Promise(async (resolve, reject) => {
		const path = ext === 'png' ? filePathImages : filePathGIF
		s3Bucket.upload({
			Key: `${path}/${id}.${ext}`,
			Body: ss, 
			Metadata: {
				'width': videoDimensions.width.toString(),
				'height': videoDimensions.height.toString()
			}
		}, (err) => {
			if (err) reject(err)
			else {
				console.log(`Successfully uploaded ${id}.${ext}`)
				resolve()
			}
		})
	})
}

async function takeScreenshots(vidEl, id){
	const allScreenshots = []

	// find video dimensions
	const videoDimensions = await vidEl.evaluate(() => ({
		width: document.documentElement.clientWidth,
		height: document.documentElement.clientHeight
	}))

	// loop through frames in sequence
	for (const frame of frameRange){
		const ss = await vidEl.screenshot({path: ''})
		const str = ss.toString('base64')

		// save all screenshots locally
		allScreenshots.push({index: frame, str, ss, id})
	}

	return {allScreenshots, videoDimensions}
}

async function processImage(file, ctx, encoder, dimensions){
	const image = new Image()
	const {canvasWidth, canvasHeight, width, height} = dimensions

	const x = width > canvasWidth ? (canvasWidth - width) / 2 : 0
	const y = height > canvasHeight ? (canvasHeight - height) / 2 : 0

	image.onload = () => {
		ctx.drawImage(image, x, y)
		ctx.getImageData(0, 0, canvasWidth, canvasHeight)

		encoder.addFrame(ctx)
	}

	image.src = `data:image/png;base64,${file.str}`
}

async function makeGIF(allScreenshots, videoDimensions, algorithm){
	const {width, height} = videoDimensions
	const canvasWidth = 500 
	const canvasHeight = 281 
	const dimensions  = {width, height, canvasWidth, canvasHeight}
        
	// setup encoder
	const encoder = new GIFEncoder(canvasWidth, canvasHeight, algorithm)

	// setup canvas
	const canvas = createCanvas(canvasWidth, canvasHeight)// .style('width', `${canvasWidth}px`).style('height', `${canvasHeight}px`)
	const ctx = canvas.getContext('2d')

	// start encoder
	encoder.start()
	encoder.setDelay(200)

	// process images in sequence
	for (const file of allScreenshots){
		await processImage(file, ctx, encoder, dimensions).catch(error => console.error(`Error processing images for gif: ${error}`))
	}
	
	// finish encoder
	encoder.finish()
	const buffer = encoder.out.getData()

	return buffer
}

async function makeZoo(cam){
	// launch headless browser
	const browser = await firefox.launch({headless: true,  timeout: 5000, args: ['--no-sandbox']}).catch(e => console.error(`error launching browser: ${e}`))
    
	// launch a single page 
	const page = await browser.newPage({_recordVideos: true}).catch(e => console.error(`error launching new page: ${e}`))
            
	// navigate to page and find video element
	const vidEl = await findVideo(page, cam).catch(error => console.error(`Error finding video element: ${error}`))
        
	// take screenshots of video element
	const {allScreenshots, videoDimensions} = await takeScreenshots(vidEl, cam.id).catch(error => `Error taking screenshots: '${error}`)
        
	// close browser 
	await browser.close().catch(error => console.error(`Error closing browser: ${error}`))
        
	// setup gif encoder
	const gif = await makeGIF(allScreenshots, videoDimensions, 'neuquant').catch(error => console.error(`Error setting up encoder: ${error}`))

	// send first screenshot to s3 for placeholder
	await saveToS3(allScreenshots[0].ss, videoDimensions, cam.id, 'png')
		.catch(err => console.error(`Issue saving image: ${err}`))
        
	// send gif to s3
	await saveToS3(gif, videoDimensions, cam.id, 'gif')
		.catch(err => console.error(`Issue saving gif: ${err}`))

	// return value to resolve
	return `finished all the things for ${cam.id}`
}


(async function loopThroughCams(){
	const sa = [7, 20, 21, 22, 23, 24, 27]
	const sub = webcams// .slice(0, 30)// .filter(d => sa.includes(+d.id))
    
	for (const cam of sub){
		const output = await makeZoo(cam).catch(error => console.error(`Error getting zoos: ${error}`))
		console.log({output})
	}

	console.log('for loop finished!')
})().catch(error => console.error(`Error looping through cams: ${error}`))